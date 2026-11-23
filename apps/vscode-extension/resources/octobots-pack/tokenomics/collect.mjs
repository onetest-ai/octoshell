#!/usr/bin/env node
// Tokenomics collector — Stage 1 (raw, append-only, no judgement).
//
// Scans this repo's Claude Code transcripts and emits one segment record per
// (session x agent x git branch) into `.octobots/tokenomics/raw/segments.jsonl`.
//
// Near-pure derivation: no board reads, no pricing. Re-running is safe and
// idempotent — segments are keyed by `segment_id` and rewritten in place, so a
// mission that gets more work later simply updates its segment.
//
// The one exception is git: a record whose `gitBranch` is the literal "HEAD" gets
// its branch from the reflog (see "Branch recovery" below).
//
// Why this layer exists separately: Claude Code transcripts are not in git and
// are large (~80MB for one session). These segments ARE the durable artifact — they
// must be collected while the transcripts still exist, which is why the gate
// runs this on every mission completion rather than at submission time.
//
// Where transcripts are read from — roots, in priority order (see README):
//   1. explicit: `--projects-dir DIR` or env OCTOBOTS_TOKENOMICS_PROJECTS_DIR
//   2. `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`
//   3. legacy repo-local `<main checkout>/.claude/projects` (read in ADDITION)
// Under each root only THIS project's slug directories (main checkout and worktrees) are read.
//
// Usage: node .octobots/tokenomics/collect.mjs [--project-dir DIR] [--projects-dir DIR] [--quiet]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitFreeEnv, listSessions, locateTranscripts } from "./checkouts.mjs";

const args = process.argv.slice(2);
// --help prints usage and exits before the script reads or writes anything.
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node .octobots/tokenomics/collect.mjs [--project-dir DIR] [--projects-dir DIR] [--quiet]");
  process.exit(0);
}
const quiet = args.includes("--quiet");
const log = (...a) => { if (!quiet) console.error(...a); };

// ---------------------------------------------------------------------------
// Locate the transcripts: roots, slug and worktree unwinding are ONE rule in
// checkouts.mjs, shared with verify.mjs. Artifacts are written to the CURRENT
// checkout (so a worktree stays isolated); transcripts are looked up
// by the slugs of the MAIN checkout and its worktrees.
// ---------------------------------------------------------------------------
const LOCATED = locateTranscripts(args);
const { projectDir: PROJECT_DIR, mainDir: MAIN_DIR, slug: PROJECT_SLUG, roots: ROOTS } = LOCATED;

const OUT_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");
const RAW_DIR = join(OUT_DIR, "raw");

// The 5m/1h cache-creation split is tracked separately because the two bill at
// different rates (1.25x vs 2x input). Collapsing them loses real money.
const TOKEN_KEYS = [
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "cache_creation_5m_tokens", "cache_creation_1h_tokens",
];

// ---------------------------------------------------------------------------
// Branch recovery (upstreamed from coach-android's fork, 2026-08-07).
//
// `gitBranch` is the attribution key. Claude Code builds from mid-2026 wrote the
// literal "HEAD" on every record, even for a session that ran its whole length
// on a named branch (2400 of 2400 records in one project). Every segment then
// buckets under one meaningless branch, the rollup maps it to no mission, and
// the campaign reports as unattributed while this script exits 0. Current builds
// record the real branch; the fallback matters when old transcripts are
// collected again.
//
// For a "HEAD" record the branch is read from the reflog of the main checkout,
// which records which branch HEAD pointed at over time. Only "HEAD" triggers it:
// a record with no gitBranch (a session outside git) stays "(none)", and a real
// branch name always wins. A record is resolved only when the reflog covers its
// time (it is at or after the oldest reflog entry); otherwise it stays "HEAD".
// So a re-clone at the same path, an expired reflog (90 days by default), or git
// failing or timing out leaves old records unresolved instead of pinning them to
// whatever branch is checked out now.
// ---------------------------------------------------------------------------
function gitIn(dir, ...a) {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 1 << 28, env: gitFreeEnv() });
  } catch {
    return "";
  }
}

// [{ at: Date, branch }] ascending; `branch` is current from `at` onward.
const timelines = new Map(); // checkout -> timeline; each worktree has its own HEAD and reflog
function branchTimeline(dir) {
  if (timelines.has(dir)) return timelines.get(dir);
  const events = [];
  let earliestFrom = null;
  let start = null; // the oldest reflog entry of any kind: where the reflog's coverage begins
  for (const line of gitIn(dir, "reflog", "--date=iso-strict", "--format=%gd|%gs").split("\n")) {
    const e = line.match(/^HEAD@\{(.+?)\}\|(.*)$/);
    if (!e) continue;
    const at = new Date(e[1]);
    if (isNaN(at)) continue;
    if (!start || at < start) start = at;
    const m = e[2].match(/^checkout: moving from (\S+) to (\S+)$/);
    if (!m) continue;
    events.push({ at, branch: m[2] });
    // The reflog is newest first, so the last checkout parsed is the oldest; the
    // branch it moved FROM is what HEAD was on from the reflog's start until then.
    earliestFrom = m[1];
  }
  events.sort((a, b) => a.at - b.at);
  // From the reflog's start until the first checkout, HEAD was on the branch that
  // checkout moved from (or, with no checkout at all, on the current branch).
  // Before the reflog's start nothing is known: no seed, so those records stay "HEAD".
  const seed = earliestFrom || (start ? gitIn(dir, "symbolic-ref", "--short", "HEAD").trim() : "");
  if (seed && start) events.unshift({ at: start, branch: seed });
  timelines.set(dir, events);
  return events;
}

function resolveBranch(gitBranch, timestamp, checkout) {
  if (gitBranch !== "HEAD" || !checkout) return gitBranch || "(none)";
  const t = timestamp ? new Date(timestamp) : null;
  if (t && !isNaN(t)) {
    let cur = null;
    for (const e of branchTimeline(checkout)) {
      if (e.at <= t) cur = e.branch;
      else break;
    }
    if (cur) return cur;
  }
  return "HEAD";
}

// ---------------------------------------------------------------------------
// Aggregate one transcript file into per-branch buckets.
//
// Two correctness details that dominate the numbers:
//   * dedupe on `requestId` — streaming re-emits the same `usage` payload on
//     several records; without this every token count roughly doubles.
//   * the branch is resolved PER RECORD, and one long session spans many
//     branches, so buckets are per-branch, not per-file.
// ---------------------------------------------------------------------------
// `checkout`: the directory whose reflog covers this session, or null (a removed worktree).
// `skip`: request ids already counted in another copy; a record without an id cannot be told apart.
function aggregate(file, checkout, skip) {
  const buckets = new Map(); // branch -> bucket
  const seen = new Set();
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return buckets;
  }

  for (const line of text.split("\n")) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant") continue;

    const msg = d.message;
    if (!msg || typeof msg !== "object") continue;

    const branch = resolveBranch(d.gitBranch, d.timestamp, checkout);
    let b = buckets.get(branch);
    if (!b) {
      b = {
        branch,
        head: 0, // turns whose record said "HEAD": the only ones that can move between branches
        ids: [],
        turns: 0,
        tools: {},
        by_model: {},
        started_at: null,
        ended_at: null,
        unpriced_models: new Set(),
      };
      buckets.set(branch, b);
    }

    const rid = d.requestId;
    if (skip ? !rid || skip.has(rid) : false) continue;
    if (rid && seen.has(rid)) continue;
    if (rid) seen.add(rid);

    b.ids.push(rid);
    b.turns += 1;
    if (d.gitBranch === "HEAD") b.head += 1;
    if (d.timestamp) {
      if (!b.started_at || d.timestamp < b.started_at) b.started_at = d.timestamp;
      if (!b.ended_at || d.timestamp > b.ended_at) b.ended_at = d.timestamp;
    }

    const model = msg.model || "(unknown)";
    const usage = msg.usage || {};
    const m = (b.by_model[model] ??= Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])));
    for (const k of TOKEN_KEYS) m[k] += usage[k] ?? 0;

    // `cache_creation` carries the per-TTL breakdown of cache_creation_input_tokens.
    // When it's absent, attribute the whole write to the 5m bucket (the cheaper,
    // default TTL) so an unknown split never inflates the reported cost.
    const cc = usage.cache_creation;
    if (cc) {
      m.cache_creation_5m_tokens += cc.ephemeral_5m_input_tokens ?? 0;
      m.cache_creation_1h_tokens += cc.ephemeral_1h_input_tokens ?? 0;
    } else {
      m.cache_creation_5m_tokens += usage.cache_creation_input_tokens ?? 0;
    }

    for (const c of msg.content ?? []) {
      if (c && c.type === "tool_use") b.tools[c.name] = (b.tools[c.name] ?? 0) + 1;
    }
  }
  return buckets;
}

// Every `*.jsonl` beneath `root`, at any depth, as {dir, file} pairs.
function* walkJsonl(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith(".jsonl")) yield { dir: root, file: entry.name };
  }
}

// segment -> its turns recorded as "HEAD". Beside the segments, so nothing of it is written to disk.
const headTurns = new WeakMap();

function bucketToSegment(bucket, base) {
  const segment = {
    ...base,
    branch: bucket.branch,
    started_at: bucket.started_at,
    ended_at: bucket.ended_at,
    turns: bucket.turns,
    models_used: Object.keys(bucket.by_model).sort(),
    tokens_by_model: bucket.by_model,
    tools: bucket.tools,
  };
  headTurns.set(segment, bucket.head);
  return segment;
}

// Two parts of one segment, with no request in common.
function addSegments(a, b) {
  const tokens = structuredClone(a.tokens_by_model);
  for (const [model, m] of Object.entries(b.tokens_by_model)) {
    const t = (tokens[model] ??= Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])));
    for (const k of TOKEN_KEYS) t[k] += m[k];
  }
  const tools = { ...a.tools };
  for (const [k, n] of Object.entries(b.tools)) tools[k] = (tools[k] ?? 0) + n;
  const times = (k) => [a[k], b[k]].filter(Boolean).sort();
  const out = {
    ...a, started_at: times("started_at")[0] ?? null, ended_at: times("ended_at").at(-1) ?? null, turns: a.turns + b.turns,
    models_used: Object.keys(tokens).sort(), tokens_by_model: tokens, tools,
  };
  headTurns.set(out, (headTurns.get(a) ?? 0) + (headTurns.get(b) ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// Read this project's slug directories (checkouts.mjs) under every transcript root. Other
// projects' slugs are never touched. Subdirectories of a session hold its
// subagent transcripts. The same session can appear in two roots (e.g. a
// symlinked or copied snapshot): segments dedupe on segment_id, keeping the
// copy with more turns (the more complete one), earlier root winning ties.
// ---------------------------------------------------------------------------
function collect() {
  // A session can be in two slugs, as a copy or split by a move into a worktree. Per thread the fuller
  // class counts (main winning ties), plus whatever requests only the other one holds.
  const classes = new Map(); // scope -> { main, wt }, each segment_id -> segment
  let current = "main";
  const segments = { push(s, from) {
    const sc = scopeOf(s.segment_id);
    if (!classes.has(sc)) classes.set(sc, { main: new Map(), wt: new Map(), ids: { main: new Set(), wt: new Set() }, again: { main: [], wt: [] } });
    const m = classes.get(sc)[current];
    for (const id of from.bucket.ids) if (id) classes.get(sc).ids[current].add(id);
    classes.get(sc).again[current].push(from);
    const prev = m.get(s.segment_id);
    if (!prev || s.turns > prev.turns) m.set(s.segment_id, s);
  } };

  const sessions = listSessions(LOCATED);
  for (const { dir: slugDir, slug, sessionId, file: sessionFile, checkout } of sessions) {
    current = slug === PROJECT_SLUG ? "main" : "wt";
    // --- main thread (the orchestrator) ---
    for (const bucket of aggregate(sessionFile, checkout).values()) {
      if (bucket.turns === 0) continue;
      const base = (branch) => ({
        segment_id: `${sessionId}:main:${branch}`,
        session_id: sessionId,
        project_slug: slug,
        kind: "orchestrator",
        agent_type: null,
      });
      segments.push(bucketToSegment(bucket, base(bucket.branch)), { bucket, file: sessionFile, checkout, base });
    }

    // --- subagents: every *.jsonl under <session>/subagents/, RECURSIVELY ---
    // Physically separate files are what make the orchestrator-vs-subagent
    // cost split exact rather than modelled — but only if we find them all.
    // Plain Task subagents sit directly in `subagents/`; Workflow-tool agents
    // nest under `subagents/workflows/wf_<id>/`. A flat read misses the
    // latter, which are the large majority of subagent files, and silently
    // reports orchestrator_cost_pct as 100%.
    const subDir = join(slugDir, sessionId, "subagents");
    if (!existsSync(subDir)) continue;
    for (const { dir, file } of walkJsonl(subDir)) {
      const agentId = file.slice(0, -6);
      let meta = {};
      const metaPath = join(dir, `${agentId}.meta.json`);
      if (existsSync(metaPath)) {
        try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* keep {} */ }
      }
      // `subagents/workflows/wf_<id>/…` — record which workflow run it belongs to.
      const workflowId = dir.split("/").find((p) => p.startsWith("wf_")) ?? null;
      for (const bucket of aggregate(join(dir, file), checkout).values()) {
        if (bucket.turns === 0) continue;
        const base = (branch) => ({
          segment_id: `${sessionId}:${agentId}:${branch}`,
          session_id: sessionId,
          project_slug: slug,
          kind: "subagent",
          agent_type: meta.agentType ?? null,
          agent_description: meta.description ?? null,
          spawn_depth: meta.spawnDepth ?? null,
          workflow_id: workflowId,
        });
        segments.push(bucketToSegment(bucket, base(bucket.branch)), { bucket, file: join(dir, file), checkout, base });
      }
    }
  }
  if (!sessions.length) log(`tokenomics: no transcripts for slug ${PROJECT_SLUG} under ${ROOTS.join(", ")} — nothing to collect`);
  const size = (m) => [...m.values()].reduce((t, s) => t + s.turns, 0);
  return [...classes.values()].flatMap((c) => {
    const [win, lose] = size(c.wt) > size(c.main) ? ["wt", "main"] : ["main", "wt"];
    const files = new Map(c.again[lose].map((f) => [f.file, f]));
    for (const { file, checkout, base } of files.values()) {
      for (const bucket of aggregate(file, checkout, c.ids[win]).values()) {
        if (bucket.turns === 0) continue;
        for (const id of bucket.ids) c.ids[win].add(id);
        const s = bucketToSegment(bucket, base(bucket.branch));
        const prev = c[win].get(s.segment_id);
        c[win].set(s.segment_id, prev ? addSegments(prev, s) : s);
      }
    }
    return [...c[win].values()];
  });
}

// ---------------------------------------------------------------------------
// Merge with anything already on disk: a re-run must never lose segments whose
// transcripts have since been pruned. Freshly collected records win on id.
//
// But `segment_id` embeds the branch (`<session>:<agent>:<branch>`), so resolving
// a "HEAD" record's branch RE-KEYS its segment, and a pure merge on id keeps the
// old `...:HEAD` key beside the new one and counts the same work twice
// (coach-android's total doubled from $223 to $449 when reflog recovery first
// ran). Only a turn whose record says "HEAD" can ever move between branches, so those turns are
// counted while collecting. The rules, per session+agent that was just re-scanned:
//   * no such turn on disk: every row stands alone, and the larger of stored and fresh wins, so a
//     shortened or pruned transcript shrinks nothing;
//   * stored `...:HEAD` rows are dropped when the re-scan holds enough HEAD turns to account for them;
//   * a stored row that lost turns no more than the HEAD turns explain has MOVED: the re-scan
//     replaces the rows if it found more turns in all, and at an equal total the branches known
//     earlier stay (a re-run after the reflog expired must not swap a known branch for HEAD);
//   * otherwise the transcript was shortened: the stored rows stay, and only rows without a HEAD
//     turn may still grow or be added - unless the transcript alone still holds more turns.
// A session that was not re-scanned is untouched.
// ---------------------------------------------------------------------------
function scopeOf(id) {
  const p = String(id).split(":");
  return p.length >= 3 ? `${p[0]}:${p[1]}` : null;
}

function merge(fresh) {
  const byId = new Map();
  const outFile = join(RAW_DIR, "segments.jsonl");
  if (existsSync(outFile)) {
    for (const line of readFileSync(outFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.segment_id) byId.set(d.segment_id, d);
      } catch { /* skip corrupt line */ }
    }
  }
  const before = byId.size;
  const group = (list) => {
    const m = new Map();
    for (const s of list) { const sc = scopeOf(s.segment_id); m.set(sc, [...(m.get(sc) ?? []), s]); }
    return m;
  };
  const total = (list) => list.reduce((t, s) => t + (s.turns ?? 0), 0);
  const keepLarger = (s) => { if (s.turns >= (byId.get(s.segment_id)?.turns ?? 0)) byId.set(s.segment_id, s); };
  const storedBy = group(byId.values());
  for (const [sc, now] of group(fresh)) {
    const old = storedBy.get(sc) ?? [];
    const heads = now.reduce((t, s) => t + (headTurns.get(s) ?? 0), 0);
    if (heads === 0) { now.forEach(keepLarger); continue; }
    const freshTurns = new Map(now.map((s) => [s.segment_id, s.turns]));
    const stale = old.filter((s) => s.branch === "HEAD" && !freshTurns.has(s.segment_id));
    const superseded = total(stale) <= heads ? stale : [];
    const missing = old.filter((s) => !superseded.includes(s))
      .reduce((t, s) => t + Math.max(0, (s.turns ?? 0) - (freshTurns.get(s.segment_id) ?? 0)), 0);
    if (missing === 0) {
      for (const s of superseded) byId.delete(s.segment_id);
      now.forEach(keepLarger);
    } else if (missing <= heads && total(now) > total(old)) {
      for (const s of old) byId.delete(s.segment_id);
      for (const s of now) byId.set(s.segment_id, s);
    } else if (!(missing <= heads && total(now) === total(old))) {
      now.filter((s) => !headTurns.get(s)).forEach(keepLarger);
      const kept = [...byId.values()].filter((s) => scopeOf(s.segment_id) === sc);
      if (total(kept) < total(now)) { // disk holds more than that: it is the better record
        for (const s of kept) byId.delete(s.segment_id);
        for (const s of now) byId.set(s.segment_id, s);
      }
    }
  }
  return { records: [...byId.values()].sort((a, b) => a.segment_id.localeCompare(b.segment_id)), before };
}

const fresh = collect();
const { records, before } = merge(fresh);

mkdirSync(RAW_DIR, { recursive: true });
writeFileSync(join(RAW_DIR, "segments.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const turns = records.reduce((n, r) => n + r.turns, 0);
const branches = new Set(records.map((r) => r.branch)).size;
log(
  `tokenomics: ${records.length} segments (${records.length - before} new) · ` +
  `${turns} turns · ${branches} branches · ${new Set(records.map((r) => r.session_id)).size} sessions`,
);
log(`tokenomics: wrote ${join(RAW_DIR, "segments.jsonl")}`);
