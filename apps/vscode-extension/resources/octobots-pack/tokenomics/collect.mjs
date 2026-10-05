#!/usr/bin/env node
// Tokenomics collector — Stage 1 (raw, append-only, no judgement).
//
// Scans this repo's Claude Code transcripts and emits one segment record per
// (session x agent x git branch) into `.octobots/tokenomics/raw/segments.jsonl`.
//
// Pure derivation: no board reads, no git, no pricing. Re-running is safe and
// idempotent — segments are keyed by `segment_id` and rewritten in place, so a
// mission that gets more work later simply updates its segment.
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
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const log = (...a) => { if (!quiet) console.error(...a); };

// ---------------------------------------------------------------------------
// Locate the main repo. Transcripts are keyed by the MAIN checkout's path (the
// slug), never by a worktree copy's, so unwind a worktree path.
// ---------------------------------------------------------------------------
function resolveProjectDir() {
  const i = args.indexOf("--project-dir");
  // resolve(): a relative path or a trailing slash must not change the slug.
  return resolve(i !== -1 ? args[i + 1] : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
}

// Artifacts are written to the CURRENT checkout (so a worktree stays isolated);
// transcripts are only ever looked up by the MAIN checkout's slug, since a
// worktree has no transcript directory of its own.
const PROJECT_DIR = resolveProjectDir();
const wt = PROJECT_DIR.indexOf("/.claude/worktrees/");
const MAIN_DIR = wt !== -1 ? PROJECT_DIR.slice(0, wt) : PROJECT_DIR;

const OUT_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");
const RAW_DIR = join(OUT_DIR, "raw");

// Claude Code names a project's transcript dir by replacing every character that
// is not [A-Za-z0-9] in the absolute path with "-" ("/", "_" and "." included:
// `applied_ai` is stored as `applied-ai`).
const PROJECT_SLUG = MAIN_DIR.replace(/[^A-Za-z0-9]/g, "-");

function resolveRoots() {
  const i = args.indexOf("--projects-dir");
  const explicit = (i !== -1 ? args[i + 1] : null) || process.env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR;
  const roots = explicit
    ? [explicit]
    : [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")];
  roots.push(join(MAIN_DIR, ".claude", "projects")); // legacy snapshot, read in addition
  return [...new Set(roots)];
}
const ROOTS = resolveRoots();

// The 5m/1h cache-creation split is tracked separately because the two bill at
// different rates (1.25x vs 2x input). Collapsing them loses real money.
const TOKEN_KEYS = [
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "cache_creation_5m_tokens", "cache_creation_1h_tokens",
];

// ---------------------------------------------------------------------------
// Aggregate one transcript file into per-branch buckets.
//
// Two correctness details that dominate the numbers:
//   * dedupe on `requestId` — streaming re-emits the same `usage` payload on
//     several records; without this every token count roughly doubles.
//   * `gitBranch` is stamped on EVERY record, and one long session spans many
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

    const branch = d.gitBranch || "(none)";
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
// ---------------------------------------------------------------------------
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
