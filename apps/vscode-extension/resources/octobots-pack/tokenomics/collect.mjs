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
// Why this layer exists separately: `.claude/projects/` is not in git and is
// large (~80MB for one session). These segments ARE the durable artifact — they
// must be collected while the transcripts still exist, which is why the gate
// runs this on every mission completion rather than at submission time.
//
// Usage: node .octobots/tokenomics/collect.mjs [--project-dir DIR] [--quiet]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const log = (...a) => { if (!quiet) console.error(...a); };

// ---------------------------------------------------------------------------
// Locate the main repo. Transcripts live under the MAIN checkout's
// `.claude/projects/`, never under a worktree copy, so unwind a worktree path.
// ---------------------------------------------------------------------------
function resolveProjectDir() {
  const i = args.indexOf("--project-dir");
  return i !== -1 ? args[i + 1] : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

// Artifacts are written to the CURRENT checkout (so a worktree stays isolated);
// transcripts are only ever read from the MAIN checkout, since worktrees have
// no `.claude/projects/` of their own.
const PROJECT_DIR = resolveProjectDir();
const wt = PROJECT_DIR.indexOf("/.claude/worktrees/");
const MAIN_DIR = wt !== -1 ? PROJECT_DIR.slice(0, wt) : PROJECT_DIR;

const OUT_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");
const RAW_DIR = join(OUT_DIR, "raw");
const PROJECTS_DIR = join(MAIN_DIR, ".claude", "projects");

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
// Walk every project slug under the repo-local `.claude/projects/`. All of them
// belong to this repo tree (the directory is repo-local), so no slug matching
// is needed — and subdirectories of a session hold its subagent transcripts.
// ---------------------------------------------------------------------------
function collect() {
  if (!existsSync(PROJECTS_DIR)) {
    log(`tokenomics: no transcripts at ${PROJECTS_DIR} — nothing to collect`);
    return [];
  }

  const segments = [];
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const slugDir = join(PROJECTS_DIR, slug);
    if (!statSync(slugDir).isDirectory()) continue;

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
  return segments;
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
