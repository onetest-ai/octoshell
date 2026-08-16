#!/usr/bin/env node
// octobots-pack-version: 55
// Backfills a merge SHA into worklog.jsonl entries whose branch has since
// been deleted by `gh pr merge --delete-branch` — the ONLY moment
// `packages/graph`'s `attribute()` (task <-> file, `provenance` mode) has
// evidence to work with, and the ONLY reason this script exists.
//
// WHY THIS RUNS AT THE GATE, NOT AT SET-STATUS TIME
// `hooks/work-log.mjs` appends a worklog line on every `set-status.js`
// active/done transition — but `mission-execution` flips a task's status
// BEFORE merging its PR, so at the moment that line is written no merge SHA
// exists anywhere to record. The only guaranteed post-merge checkpoint in
// this pack is `mission-completion-gate`'s Tokenomics phase, whose entire
// reason for existing is "capture data now, because it is about to become
// unrecoverable" (see that skill's Tokenomics-capture section) — a deleted
// branch is exactly that class of loss, so this reuses the same phase
// rather than adding a new hook trigger.
//
// WHY octograph IS DETECTED, NOT ASSUMED
// This pack ships to every Octobots workspace; octograph does NOT ship in
// it (see mission-completion-gate SKILL.md). Most workspaces will never
// have it, and a merge SHA is only useful to `attribute()`'s `provenance`
// mode, which lives in octograph. Spawning `gh` and rewriting a log for a
// tool the workspace doesn't have would be cost and noise nobody asked for
// — so this script looks for octograph's own footprint before doing
// anything, and skips silently, with no `gh` call, when it finds neither.
// That is safe, not lossy: the backfill is idempotent and historical, so a
// repo that adopts octograph LATER recovers every prior mission's
// provenance on its very next gate run.
//
// DESIGN RULES (mirrors work-log.mjs's own)
//   * Idempotent — an entry that already carries merged_sha is left as the
//     exact same line (never re-serialized), so a re-run changes nothing.
//   * A branch with no merged PR is left alone, never guessed.
//   * Never fails the gate: a `gh` failure (offline, not installed, no
//     auth, no merged PR) is noted per-branch and the script still exits 0.
//   * Writes only if at least one line actually changed, and writes by
//     tmp-file + rename so the log is never observed truncated. This is a
//     read-modify-WRITE over an append-only file that is the only surviving
//     record of work whose transcripts are pruned outside the repo — a
//     `writeFileSync` straight onto the path truncates first, so a crash
//     between truncate and write destroys exactly what this script exists to
//     preserve. `rename(2)` within the same directory is atomic: a reader
//     sees the old file or the new one, never a half-written one.
//
// Usage: node backfill-worklog-sha.mjs [--project-dir DIR] [--quiet]
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const log = (...a) => { if (!quiet) console.error(...a); };

function resolveProjectDir() {
  const i = args.indexOf("--project-dir");
  return i !== -1 ? args[i + 1] : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

const PROJECT_DIR = resolveProjectDir();
const OCTOBOTS_DIR = join(PROJECT_DIR, ".octobots");
const WORKLOG_PATH = join(OCTOBOTS_DIR, "tokenomics", "worklog.jsonl");

/**
 * Whether octograph looks adopted in this workspace: either its config file
 * is checked in (`octograph.yaml` — this repo's own is the concrete
 * example), or it has already produced an artifact (`.octobots/graph/` once
 * a board exists, else standalone `.octograph/` — the same two-path rule
 * `@octoshell/graph`'s `resolveOut` uses to pick where it writes). This
 * script ships dependency-free (no `node_modules` at the install site), so
 * it re-states that two-line rule rather than importing it — the same
 * necessary duplication `entity-io.mjs` accepts for the board schema, and
 * for the same reason: nothing here can `import` from a workspace package.
 */
function octographAvailable() {
  if (existsSync(join(PROJECT_DIR, "octograph.yaml"))) return true;
  const out = existsSync(OCTOBOTS_DIR) ? join(OCTOBOTS_DIR, "graph") : join(PROJECT_DIR, ".octograph");
  return existsSync(out);
}

if (!octographAvailable()) {
  log(
    "worklog-sha-backfill: octograph not detected in this workspace " +
    "(no octograph.yaml, no graph artifact) — skipping.",
  );
  process.exit(0);
}

if (!existsSync(WORKLOG_PATH)) {
  log("worklog-sha-backfill: no worklog.jsonl — nothing to backfill.");
  process.exit(0);
}

const original = readFileSync(WORKLOG_PATH, "utf8");
const lines = original.split("\n");

// One `gh` call per distinct branch, however many worklog lines share it
// (a task logs `active` then `done` on the same branch).
const shaCache = new Map();
function resolveMergedSha(branch) {
  if (shaCache.has(branch)) return shaCache.get(branch);
  let sha = null;
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "merged", "--limit", "1", "--json", "mergeCommit"],
      { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 },
    );
    const found = JSON.parse(out);
    sha = found[0]?.mergeCommit?.oid ?? null;
  } catch (err) {
    // Offline, no gh, not authenticated, or no merged PR for this branch —
    // left alone rather than guessed. Never fails the run over it.
    log(`worklog-sha-backfill: gh lookup failed for ${branch} — ${String(err.message ?? err).split("\n")[0]}`);
  }
  shaCache.set(branch, sha);
  return sha;
}

let filled = 0;
let changed = false;
const rewritten = lines.map((line) => {
  if (line.trim() === "") return line;

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return line; // malformed line — same tolerance readWorklog applies, never fatal
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return line;
  if (entry.merged_sha != null) return line; // already filled — byte-unchanged
  if (typeof entry.branch !== "string" || entry.branch === "") return line; // nothing to resolve from

  const sha = resolveMergedSha(entry.branch);
  if (!sha) return line; // no merged PR found — left alone, not guessed

  filled++;
  changed = true;
  return JSON.stringify({ ...entry, merged_sha: sha });
});

if (changed) {
  const tmp = `${WORKLOG_PATH}.backfill.tmp`;
  try {
    writeFileSync(tmp, rewritten.join("\n"));
    renameSync(tmp, WORKLOG_PATH);
  } catch (err) {
    // The original is still intact — the rename either happened or it did
    // not. Report and exit 0, same rule as every other failure here.
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    log(`worklog-sha-backfill: could not write worklog — ${String(err.message ?? err).split("\n")[0]}`);
    process.exit(0);
  }
}

log(`worklog-sha-backfill: filled ${filled} entr${filled === 1 ? "y" : "ies"}.`);
process.exit(0);
