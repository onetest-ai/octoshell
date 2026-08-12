/**
 * Parses `.octobots/tokenomics/worklog.jsonl` — the append-only log the
 * pack's `hooks/work-log.mjs` writes one JSON line per status flip to.
 *
 * Tolerant by construction, but TWO DIFFERENT KINDS of "tolerant": this is an
 * append-only log a process can die mid-write into, so a truncated or
 * otherwise unparseable final line is the EXPECTED state of the file, not an
 * error condition, and is skipped in true silence — the well-formed lines
 * around it are still returned, and nothing here ever throws on file
 * content. A line that IS valid JSON but is missing a field this package
 * treats as required is a different thing: a record exists, `work-log.mjs`
 * really did write it, and it is being dropped for a reason that a truncated
 * tail does not share. `warn` (real stderr by default, the same seam
 * `attribution.ts`'s `attribute()` warns through — see its `defaultWarn`)
 * says so for that case and stays silent for the other, so a reader can tell
 * "the writer died mid-append, as expected" apart from "a line this package
 * cannot use actually made it to disk". Only a missing file/board
 * short-circuits to `[]` before any parsing happens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir } from "./artifact.js";
import { defaultWarn, type Warn } from "./attribution.js";

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
 * Parses one JSONL line into a `WorklogEntry`, or `null` on three DIFFERENT
 * shapes of "unusable" — only the third of which `warn`s:
 *
 *  - not valid JSON at all — a truncated tail from a writer that died
 *    mid-append, EXPECTED, silent;
 *  - valid JSON but not an object (`42`, `["x"]`) — not a record shape this
 *    format ever produces even truncated, silent for the same reason;
 *  - a valid JSON OBJECT missing `session_id` or `at` — a real record that
 *    parsed cleanly and is still being dropped. Unlike the two cases above,
 *    this is not what a mid-write death looks like (truncation corrupts JSON
 *    syntax, not just one field of it), so it is far more likely a
 *    `work-log.mjs` change, or a hand-edited line, produced something this
 *    reader cannot use — worth a line on stderr rather than vanishing the
 *    same way a torn line does.
 */
function parseLine(line: string, warn: Warn): WorklogEntry | null {
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
  if (sessionId === null || at === null) {
    const missing = [
      sessionId === null ? "session_id" : null,
      at === null ? "at" : null,
    ].filter((field): field is string => field !== null);
    warn(
      `octograph: worklog line is valid JSON but missing required field(s) (${missing.join(", ")}) ` +
        `— dropped: ${line}\n`,
    );
    return null;
  }

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
 *
 * `warn` defaults to `attribution.ts`'s real-stderr `defaultWarn` — the same
 * default `attribute()` uses — so a caller that wants every diagnostic this
 * package produces folded into one place threads its own `warn` through both
 * readers rather than this module inventing a second default.
 */
export function readWorklog(repoRoot: string, warn: Warn = defaultWarn): WorklogEntry[] {
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
    const entry = parseLine(line, warn);
    if (entry) entries.push(entry);
  }
  return entries;
}
