#!/usr/bin/env node
// Tokenomics collector for Codex CLI sessions — Stage 1, second source.
//
// Reads Codex rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`) and merges
// one segment per (session x agent x branch) into `raw/segments.jsonl`, tagged
// `source: "codex"`. Claude segments carry no `source` key and are never touched.
//
// WHITELIST — the only fields ever read from a rollout:
//   session_meta        id, timestamp, cwd, git.{branch, repository_url}, parent_thread_id, agent_path
//   turn_context        turn_id, model, effort (or collaboration_mode.settings.reasoning_effort)
//   token_usage_record  timestamp, turn_id, response_id, usage.{input,cached_input,cache_write_input,output,reasoning_output}_tokens
// Everything else (prompts, replies, tool calls and their output, instructions)
// is skipped without being parsed: a line is only JSON-parsed when it is one of
// the three record types above, and only the fields named here are copied out.
// Nothing from the rollout is stored except those values.
//
// Units. Codex reports OpenAI-style usage: `input_tokens` INCLUDES `cached_input_tokens`,
// and `output_tokens` INCLUDES `reasoning_output_tokens`. Segments use the same
// billing-shaped keys as Claude segments so rollup prices them with one code path:
//   input_tokens               = input - cached        (billed at the input rate)
//   cache_read_input_tokens    = cached                (billed at the cache-read rate)
//   cache_creation_input_tokens/_5m = cache_write      (billed at the cache-write rate)
//   output_tokens              = output                (reasoning already inside it)
//   reasoning_output_tokens    = informational only, never priced separately
//
// KNOWN GAP: the branch is stamped ONCE, at session start (`git.branch`), not per
// record like Claude's `gitBranch`. A session started on `main` from which the
// orchestrator later cuts a branch (e.g. a builder that runs with git writes off)
// maps to `main`. rollup.mjs falls back to the delivery-ledger time window for those.
//
// Compressed rollouts need a Node with zlib zstd support (22.15+). On an older Node
// they are skipped with one warning; this stage never fails the pipeline for it.
//
// Upstreamed from aquanautica/solo's fork (pack v60).
//
// Idempotent: segments are keyed by `segment_id` and rewritten in place; a re-run
// never loses a segment whose rollout has since been pruned.
//
// Usage: node .octobots/tokenomics/collect-codex.mjs [--project-dir DIR] [--codex-dir DIR]
//          [--repo owner/name] [--quiet]
//   codex dir: --codex-dir, else env OCTOBOTS_TOKENOMICS_CODEX_DIR, else $CODEX_HOME/sessions, else ~/.codex/sessions
//   repo:      --repo, else env OCTOBOTS_TOKENOMICS_CODEX_REPO, else the `origin` remote of the project

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { cwdInside, gitFreeEnv, projectCheckouts, resolveProjectDir } from "./checkouts.mjs";

const args = process.argv.slice(2);
// --help prints usage and exits before the script reads or writes anything.
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node .octobots/tokenomics/collect-codex.mjs [--project-dir DIR] [--codex-dir DIR] [--repo owner/name] [--quiet]");
  process.exit(0);
}
const quiet = args.includes("--quiet");
const log = (...a) => { if (!quiet) console.error(...a); };
const argOf = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

// The project and its main checkout, by the one rule collect.mjs and verify.mjs use (checkouts.mjs),
// so a session whose cwd is any worktree of it still matches.
const PROJECT_DIR = resolveProjectDir(args);
const { mainDir: MAIN_DIR, worktrees: WORKTREES } = projectCheckouts(PROJECT_DIR);
// A named import of zstdDecompressSync would fail to LOAD on an older Node and so fail the stage.
const zstdDecompressSync = typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : null;
let zstSkipped = 0;
const RAW_DIR = join(PROJECT_DIR, ".octobots", "tokenomics", "raw");
const OUT_FILE = join(RAW_DIR, "segments.jsonl");
const PROJECT_SLUG = MAIN_DIR.replace(/[^A-Za-z0-9]/g, "-");

const CODEX_DIR =
  argOf("--codex-dir") ?? process.env.OCTOBOTS_TOKENOMICS_CODEX_DIR ??
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

// `https://github.com/o/r.git`, `git@github.com:o/r.git`, `o/r` -> `o/r` (lowercase).
function repoKeyOf(url) {
  if (!url) return null;
  const parts = String(url).replace(/\.git$/i, "").split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : null;
}

function resolveRepoKey() {
  const explicit = argOf("--repo") ?? process.env.OCTOBOTS_TOKENOMICS_CODEX_REPO;
  if (explicit) return repoKeyOf(explicit);
  try {
    return repoKeyOf(execFileSync("git", ["remote", "get-url", "origin"], { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitFreeEnv() }).trim());
  } catch {
    return null; // no git / no origin: only the cwd rule applies
  }
}
const REPO_KEY = resolveRepoKey();

// The repository decides. The cwd is the fallback, for a session that records no repository or a
// project with no origin: a checkout of ANOTHER repository nested in ours has a cwd inside ours too.
const inThisRepo = (cwd, repoUrl) => {
  const key = repoKeyOf(repoUrl);
  if (REPO_KEY !== null && key !== null) return key === REPO_KEY;
  // A foreign repository with a vanished cwd: no .git is left to show it was nested.
  if (key !== null && !(typeof cwd === "string" && existsSync(cwd))) return false;
  return typeof cwd === "string" && cwdInside(cwd, [MAIN_DIR, ...WORKTREES]);
};

function* walkRollouts(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkRollouts(full);
    else if (e.name.startsWith("rollout-") && (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst"))) yield full;
  }
}

const TOKEN_KEYS = [
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "cache_creation_5m_tokens", "cache_creation_1h_tokens",
];
const n = (v) => (Number.isFinite(v) ? v : 0);

// One rollout -> the whitelisted facts, or null when it has no session_meta.
function readRollout(file, seenResponses) {
  let text;
  // Codex compresses older rollouts to `.jsonl.zst` (roughly three quarters of a
  // long-lived ~/.codex/sessions): read both, or all early history silently vanishes.
  if (file.endsWith(".zst") && !zstdDecompressSync) { zstSkipped++; return null; }
  try {
    const buf = readFileSync(file);
    text = (file.endsWith(".zst") ? zstdDecompressSync(buf) : buf).toString("utf8");
  } catch (e) {
    log(`tokenomics: WARN unreadable rollout ${basename(file)}: ${e.message.split("\n")[0]}`);
    return null;
  }

  let meta = null;
  const turnModel = new Map(); // turn_id -> { model, effort }
  let lastTurn = { model: null, effort: null };
  const byModel = {};
  const efforts = new Set();
  let turns = 0, startedAt = null, endedAt = null;

  for (const line of text.split("\n")) {
    // Cheap pre-filter: only the three record types we whitelist are ever parsed.
    const wanted = line.includes('"type":"token_usage_record"') ? "usage"
      : line.includes('"type":"turn_context"') ? "turn"
      : line.includes('"type":"session_meta"') ? "meta" : null;
    if (!wanted) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d?.payload;
    if (!p || typeof p !== "object") continue;

    if (d.type === "session_meta" && !meta) {
      // First session_meta is the file's own; any later ones restate a parent's history.
      meta = {
        id: p.id ?? p.session_id ?? null,
        timestamp: p.timestamp ?? d.timestamp ?? null,
        cwd: p.cwd ?? null,
        branch: p.git?.branch ?? null,
        repository_url: p.git?.repository_url ?? null,
        parent_thread_id: p.parent_thread_id ?? null,
        agent_path: p.agent_path ?? null,
      };
    } else if (d.type === "turn_context") {
      const effort = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort ?? null;
      const model = p.model ?? p.collaboration_mode?.settings?.model ?? null;
      lastTurn = { model, effort };
      if (p.turn_id) turnModel.set(p.turn_id, lastTurn);
    } else if (d.type === "token_usage_record") {
      // Per-response usage is the unit. A response id seen before (a fork copying
      // history, a restated record) counts once — the Codex analogue of requestId.
      const rid = p.response_id;
      if (rid) {
        if (seenResponses.has(rid)) continue;
        seenResponses.add(rid);
      }
      const u = p.usage;
      if (!u || typeof u !== "object") continue;
      const t = (p.turn_id && turnModel.get(p.turn_id)) || lastTurn;
      const model = t.model || "(unknown)";
      if (t.effort) efforts.add(t.effort);
      const m = (byModel[model] ??= { ...Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])), reasoning_output_tokens: 0 });
      const cached = n(u.cached_input_tokens);
      const write = n(u.cache_write_input_tokens);
      m.input_tokens += Math.max(0, n(u.input_tokens) - cached);
      m.cache_read_input_tokens += cached;
      m.cache_creation_input_tokens += write;
      m.cache_creation_5m_tokens += write;
      m.output_tokens += n(u.output_tokens);
      m.reasoning_output_tokens += n(u.reasoning_output_tokens);
      turns += 1;
      if (d.timestamp) {
        if (!startedAt || d.timestamp < startedAt) startedAt = d.timestamp;
        if (!endedAt || d.timestamp > endedAt) endedAt = d.timestamp;
      }
    }
  }
  if (!meta || !meta.id) return null;
  return { meta, byModel, efforts, turns, startedAt, endedAt };
}

function collect() {
  if (!existsSync(CODEX_DIR)) {
    log(`tokenomics: no Codex sessions at ${CODEX_DIR} — nothing to collect`);
    return [];
  }
  const seen = new Set();
  const rollouts = [];
  const threads = new Set(); // a session present as both .jsonl and .jsonl.zst counts once
  for (const file of [...walkRollouts(CODEX_DIR)].sort()) {
    const r = readRollout(file, seen);
    if (!r || threads.has(r.meta.id)) continue;
    threads.add(r.meta.id);
    if (inThisRepo(r.meta.cwd, r.meta.repository_url)) rollouts.push(r);
  }
  if (zstSkipped) {
    console.error(`tokenomics: WARN ${zstSkipped} compressed Codex rollout(s) skipped: Node ${process.version} cannot read zstd (22.15+ can)`);
  }
  const parentOf = new Map(rollouts.map((r) => [r.meta.id, r.meta.parent_thread_id]));
  const rootOf = (id) => {
    const guard = new Set();
    let cur = id;
    while (parentOf.get(cur) && !guard.has(cur)) { guard.add(cur); cur = parentOf.get(cur); }
    return cur;
  };

  const out = [];
  for (const r of rollouts) {
    if (r.turns === 0) continue;
    const { meta } = r;
    const branch = meta.branch || "(none)";
    const agentKey = meta.agent_path || "codex";
    const efforts = [...r.efforts].sort();
    out.push({
      segment_id: `codex:${meta.id}:${agentKey}:${branch}`,
      session_id: meta.parent_thread_id ? rootOf(meta.id) : meta.id,
      thread_id: meta.id,
      parent_thread_id: meta.parent_thread_id,
      project_slug: PROJECT_SLUG,
      source: "codex",
      kind: meta.parent_thread_id ? "codex-subagent" : "codex",
      agent_type: meta.agent_path ? basename(meta.agent_path) : null,
      agent_path: meta.agent_path,
      branch,
      cwd: meta.cwd,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      turns: r.turns,
      models_used: Object.keys(r.byModel).sort(),
      efforts_used: efforts,
      tokens_by_model: r.byModel,
      tools: {},
    });
  }
  return out;
}

// Merge with what is on disk: freshly collected records win on segment_id, every
// other record (Claude or an already-pruned Codex rollout) is kept as written.
function merge(fresh) {
  const byId = new Map();
  if (existsSync(OUT_FILE)) {
    for (const line of readFileSync(OUT_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.segment_id) byId.set(d.segment_id, d);
      } catch { /* skip corrupt line */ }
    }
  }
  const before = byId.size;
  // A rollout shortened since it was collected must not shrink its row.
  for (const s of fresh) if (!((byId.get(s.segment_id)?.turns ?? 0) > s.turns)) byId.set(s.segment_id, s);
  return { records: [...byId.values()].sort((a, b) => a.segment_id.localeCompare(b.segment_id)), before };
}

const fresh = collect();
if (fresh.length || existsSync(OUT_FILE)) {
  const { records, before } = merge(fresh);
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(OUT_FILE, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  log(
    `tokenomics: codex ${fresh.length} segments (${records.length - before} new) · ` +
    `${fresh.reduce((t, s) => t + s.turns, 0)} responses · ${new Set(fresh.map((s) => s.session_id)).size} sessions · ` +
    `repo ${REPO_KEY ?? "(cwd only)"}`,
  );
  log(`tokenomics: wrote ${OUT_FILE}`);
}
