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
// Under each root only THIS project's slug directory is read.
//
// Usage: node .octobots/tokenomics/collect.mjs [--project-dir DIR] [--projects-dir DIR] [--quiet]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { locateTranscripts } from "./roots.mjs";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const log = (...a) => { if (!quiet) console.error(...a); };

// ---------------------------------------------------------------------------
// Locate the transcripts: roots, slug and worktree unwinding are ONE rule in
// roots.mjs, shared with verify.mjs. Artifacts are written to the CURRENT
// checkout (so a worktree stays isolated); transcripts are only ever looked up
// by the MAIN checkout's slug.
// ---------------------------------------------------------------------------
const { projectDir: PROJECT_DIR, mainDir: MAIN_DIR, slug: PROJECT_SLUG, roots: ROOTS } = locateTranscripts(args);

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
// branch name always wins. Limits: the reflog is local to this checkout (work
// done in a clone or on CI resolves to nothing here) and expires (90 days by
// default). Both are honest outcomes; neither invents a mission.
// ---------------------------------------------------------------------------
function gitIn(...a) {
  try {
    return execFileSync("git", ["-C", MAIN_DIR, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  } catch {
    return "";
  }
}

// [{ at: Date, branch }] ascending; `branch` is current from `at` onward.
let timeline;
function branchTimeline() {
  if (timeline) return timeline;
  const events = [];
  let earliestFrom = null;
  for (const line of gitIn("reflog", "--date=iso-strict", "--format=%gd|%gs").split("\n")) {
    const m = line.match(/^HEAD@\{(.+?)\}\|checkout: moving from (\S+) to (\S+)$/);
    if (!m) continue;
    const at = new Date(m[1]);
    if (isNaN(at)) continue;
    events.push({ at, branch: m[3] });
    // The reflog is newest first, so the last checkout parsed is the oldest; the
    // branch it moved FROM is what the repo was on before any checkout.
    earliestFrom = m[2];
  }
  events.sort((a, b) => a.at - b.at);
  // Records older than every checkout belong to the branch the repo started on,
  // else the current branch when the reflog holds no checkout at all.
  const seed = earliestFrom || gitIn("symbolic-ref", "--short", "HEAD").trim();
  if (seed) events.unshift({ at: new Date(0), branch: seed });
  timeline = events;
  return timeline;
}

function resolveBranch(gitBranch, timestamp) {
  if (gitBranch !== "HEAD") return gitBranch || "(none)";
  const t = timestamp ? new Date(timestamp) : null;
  if (t && !isNaN(t)) {
    let cur = null;
    for (const e of branchTimeline()) {
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
function aggregate(file) {
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

    const branch = resolveBranch(d.gitBranch, d.timestamp);
    let b = buckets.get(branch);
    if (!b) {
      b = {
        branch,
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
    if (rid && seen.has(rid)) continue;
    if (rid) seen.add(rid);

    b.turns += 1;
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

function bucketToSegment(bucket, base) {
  return {
    ...base,
    branch: bucket.branch,
    started_at: bucket.started_at,
    ended_at: bucket.ended_at,
    turns: bucket.turns,
    models_used: Object.keys(bucket.by_model).sort(),
    tokens_by_model: bucket.by_model,
    tools: bucket.tools,
  };
}

// ---------------------------------------------------------------------------
// Read this project's own slug directory under every transcript root. Other
// projects' slugs are never touched. Subdirectories of a session hold its
// subagent transcripts. The same session can appear in two roots (e.g. a
// symlinked or copied snapshot): segments dedupe on segment_id, keeping the
// copy with more turns (the more complete one), earlier root winning ties.
// ---------------------------------------------------------------------------
function collect() {
  const bySegment = new Map();
  const segments = { push(s) {
    const prev = bySegment.get(s.segment_id);
    if (!prev || s.turns > prev.turns) bySegment.set(s.segment_id, s);
  } };

  let found = 0;
  for (const root of ROOTS) {
    const slug = PROJECT_SLUG;
    const slugDir = join(root, slug);
    if (!existsSync(slugDir) || !statSync(slugDir).isDirectory()) continue;
    found++;

    for (const entry of readdirSync(slugDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -6);
      const sessionFile = join(slugDir, entry);

      // --- main thread (the orchestrator) ---
      for (const bucket of aggregate(sessionFile).values()) {
        if (bucket.turns === 0) continue;
        segments.push(bucketToSegment(bucket, {
          segment_id: `${sessionId}:main:${bucket.branch}`,
          session_id: sessionId,
          project_slug: slug,
          kind: "orchestrator",
          agent_type: null,
        }));
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
        for (const bucket of aggregate(join(dir, file)).values()) {
          if (bucket.turns === 0) continue;
          segments.push(bucketToSegment(bucket, {
            segment_id: `${sessionId}:${agentId}:${bucket.branch}`,
            session_id: sessionId,
            project_slug: slug,
            kind: "subagent",
            agent_type: meta.agentType ?? null,
            agent_description: meta.description ?? null,
            spawn_depth: meta.spawnDepth ?? null,
            workflow_id: workflowId,
          }));
        }
      }
    }
  }
  if (!found) log(`tokenomics: no transcripts for slug ${PROJECT_SLUG} under ${ROOTS.join(", ")} — nothing to collect`);
  return [...bySegment.values()];
}

// ---------------------------------------------------------------------------
// Merge with anything already on disk: a re-run must never lose segments whose
// transcripts have since been pruned. Freshly collected records win on id.
//
// But `segment_id` embeds the branch (`<session>:<agent>:<branch>`), so a change
// in how a branch is resolved RE-KEYS a segment, and a pure merge on id keeps the
// old key beside the new one and counts the same work twice (coach-android's
// total doubled from $223 to $449 when reflog recovery first ran). So a
// session+agent that was just re-scanned is authoritative for itself: its stale
// keys are dropped. A session that was NOT re-scanned (the pruned-transcript case
// this merge exists for) keeps everything.
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
  const freshIds = new Set(fresh.map((s) => s.segment_id));
  const freshScopes = new Set(fresh.map((s) => scopeOf(s.segment_id)).filter(Boolean));
  for (const id of [...byId.keys()]) {
    if (freshIds.has(id)) continue;
    const sc = scopeOf(id);
    if (sc && freshScopes.has(sc)) byId.delete(id); // superseded by this re-scan
  }
  for (const s of fresh) byId.set(s.segment_id, s);
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
