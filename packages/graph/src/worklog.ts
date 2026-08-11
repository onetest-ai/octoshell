/**
 * Parses `.octobots/tokenomics/worklog.jsonl` — the append-only log the
 * pack's `hooks/work-log.mjs` writes one JSON line per status flip to.
 *
 * Tolerant by construction: this is an append-only log a process can die
 * mid-write into, so a truncated or otherwise malformed final line is the
 * EXPECTED state of the file, not an error condition. A malformed line is
 * skipped; the well-formed lines around it are still returned. Nothing here
 * ever throws on file content — only a missing file/board short-circuits to
 * `[]` before any parsing happens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir } from "./artifact.js";

export interface WorklogEntry {
  sessionId: string;
  task: string | null;
  mission: string | null;
  branch: string | null;
  mergedSha: string | null;
  at: string;
}

/** `raw[key]` as a string, or `null` for anything else (absent, wrong type,
 *  `null` itself) — every optional worklog field degrades to `null` the same
 *  way, never to `undefined`, so a consumer can rely on the key being present. */
function optString(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  return typeof v === "string" ? v : null;
}

/**
 * Parses one JSONL line into a `WorklogEntry`, or `null` if the line is not
 * valid JSON, is JSON but not an object, or is missing either field this
 * package treats as required (`session_id`, `at`) — a line the hook itself
 * would never have written, so treating it as noise rather than a fatal
 * error is the more faithful reading of a partially-written line, not a
 * looser one.
 */
function parseLine(line: string): WorklogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // e.g. a truncated tail from a writer that died mid-append
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const sessionId = optString(raw, "session_id");
  const at = optString(raw, "at");
  if (sessionId === null || at === null) return null;

  return {
    sessionId,
    task: optString(raw, "task"),
    mission: optString(raw, "mission"),
    branch: optString(raw, "branch"),
    mergedSha: optString(raw, "merged_sha"),
    at,
  };
}

/**
 * Reads and parses the worklog, or `[]` when this repo has no board, or has
 * one but no worklog was ever written (a fresh install, or a board that has
 * never flipped a task/mission status through `set-status.js`).
 */
export function readWorklog(repoRoot: string): WorklogEntry[] {
  const root = boardDir(repoRoot);
  if (root === null) return [];

  let text: string;
  try {
    text = readFileSync(join(root, "tokenomics", "worklog.jsonl"), "utf8");
  } catch {
    return [];
  }

  const entries: WorklogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}
