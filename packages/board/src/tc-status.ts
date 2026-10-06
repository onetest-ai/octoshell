// Recording a test case's status: the TypeScript spelling of the NON-MIGRATE path of the pack's
// `resources/octobots-pack/skill/mission-planner/scripts/set-test-status.js` (its `--migrate` is not ported).
//
// What the panel's status dropdown writes must be, byte for byte, what an agent running that script writes:
// only frontmatter LINES change (the `status` line replaced in place or appended; for pass, fail and blocked a
// `last_run: {date: D}` line replacing any earlier last_run wholesale, inserted after status), so comments, key
// order, line endings, a BOM and the whole body survive. The result is re-parsed and compared with the old data
// before anything is written. `rewriteFrontmatter` (tc-io.ts) re-dumps the YAML and is NOT this edit.
//
// DUAL IMPLEMENTATION, like tc-io.ts: the pack script stays dependency-free, so it cannot import this. The text
// and the rules must stay equal; `test/tc-status-parity.test.ts` runs the shipped script over a shared case table
// (`test/fixtures/tc-status-cases.json`) and over every TC of the real boards. Keep the two in step.
//
// Two layers:
//  - `editTestCaseStatus(text, status, date)`: the pure edit, identical to the script for every input,
//    including a status the file already holds (for pass, fail and blocked the script re-dates last_run).
//  - `writeTestCaseStatus(boardRoot, relPath, opts)`: the file writer: the script's path rule and symlink
//    refusals, a bounded no-follow read, an optional `expect` check against the file as just read, the edit, a
//    temp file in the same folder, a final re-read, then the rename. `skipIfCurrent` is the ONE deviation from
//    the script: the host turns a re-pick of the current status into a no-op, where the script would re-date
//    last_run. It is an option, off by default, so the default is the script.
//
// Tree-shaking: the octograph payload bundles `@octoshell/board` without a `sideEffects` flag, so anything at
// this module's top level that is not provably pure would be kept. Nothing reaches this module from BoardModel;
// its top level holds only imports, literals, regex literals and function declarations, and must stay that way
// (no array spread, no `new Set(ident)`, no `new RegExp`, no top-level calls). `graph-payload.mjs --verify`
// gates it.

import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { MAX_TC_BYTES, parseFrontmatter, splitFrontmatter } from "./tc-io.js";
import { parseTestCase } from "./test-cases.js";
import type { TestCaseRun, TestCaseStatus } from "./test-cases.js";

/** The statuses a pick can record: `unknown` is what a file with no recorded status lists as, never set. */
export type SettableTcStatus = "draft" | "ready" | "pass" | "fail" | "blocked";

/** Why the pure edit refuses. */
export type TcEditRefusal = "invalid-status" | "invalid-date" | "no-frontmatter" | "unparseable" | "unsafe";

export type TcEditResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: TcEditRefusal; message: string };

/** The status and last run a TC file holds, as the board lists them (`unknown` when no status is recorded). */
export interface TcView {
  status: TestCaseStatus;
  lastRun: TestCaseRun | null;
}

/** Why the writer refuses (the edit's reasons plus the file's). */
export type TcWriteRefusal = TcEditRefusal | "not-a-test-case" | "not-found" | "symlink" | "not-regular" | "too-large" | "unreadable" | "write-failed";

export type WriteTestCaseStatusResult =
  | { ok: true; changed: boolean }
  /** The file is not what `expect` said (or moved while the temp file was written): nothing was written; `current` is what it holds now. */
  | { ok: false; reason: "stale"; message: string; current: TcView }
  | { ok: false; reason: TcWriteRefusal; message: string };

export interface WriteTestCaseStatusOptions {
  status: SettableTcStatus;
  /** `YYYY-MM-DD` (UTC day) for pass, fail and blocked; ignored for draft and ready (the script refuses --date there). */
  date: string | null;
  /** What the caller's view of the file was: refuse as stale, writing nothing, when the file as just read holds something else. */
  expect?: { status: TestCaseStatus; lastRun?: TestCaseRun | null };
  /**
   * The host's deviation from the script: requesting the status the file already holds writes nothing
   * (`changed: false`, bytes and mtime untouched). The script, given pass on a pass file, re-dates last_run.
   */
  skipIfCurrent?: boolean;
  /**
   * Test seam: called after the temp file is written and before the final re-read, so a test can move the file at that moment.
   * It cannot skip the re-read or the compare that follow it. Production callers (the host) never pass it.
   * @internal
   */
  beforeFinalRead?: (paths: { file: string; tmp: string }) => void;
}

function isSettableStatus(s: unknown): s is SettableTcStatus {
  return s === "draft" || s === "ready" || s === "pass" || s === "fail" || s === "blocked";
}

function isRunStatus(s: SettableTcStatus): boolean {
  return s === "pass" || s === "fail" || s === "blocked";
}

/** `YYYY-MM-DD` that is a real calendar day (the script's `--date` rule). */
function isCalendarDay(d: unknown): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
}

/** A comparable form: dates as ISO strings, mapping keys sorted. */
function canon(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return v;
}

function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function refuse(reason: TcEditRefusal, message: string): TcEditResult {
  return { ok: false, reason, message };
}

// ── the pure edit ────────────────────────────────────────────────────────────────

/**
 * `text` with its frontmatter `status` set to `status`, and for pass, fail and blocked `last_run` set to
 * `{date}` (no evidence: the dropdown records none). Byte-identical to
 * `set-test-status.js <tc> <status> [--date <date>]` (non-migrate) for every input, including a status the
 * file already holds. `changed: false` (with `text` as given) when the edit would change no data: the script's
 * "(already)". Refuses, with nothing guessed, a file with no frontmatter, unparseable frontmatter, or an edit
 * the re-parse cannot prove (a quoted key, an anchor another key aliases, a flow-mapping block, ...).
 */
export function editTestCaseStatus(text: string, status: SettableTcStatus, date: string | null): TcEditResult {
  if (!isSettableStatus(status)) return refuse("invalid-status", `invalid status "${String(status)}" (expected one of: draft, ready, pass, fail, blocked)`);
  const isRun = isRunStatus(status);
  if (isRun && !isCalendarDay(date)) return refuse("invalid-date", `a ${status} run needs a calendar day as YYYY-MM-DD, got ${JSON.stringify(date)}`);

  const parts = splitFrontmatter(text);
  const fm = parseFrontmatter(text);
  if (parts && !fm.ok) return refuse("unparseable", "the frontmatter is unparseable (nothing is guessed; fix the YAML first)");
  if (!parts || !fm.ok) return refuse("no-frontmatter", "the file has no frontmatter: run set-test-status.js <file> --migrate to add it");

  const eol = /\r\n/.test(parts.yaml + parts.head) ? "\r\n" : "\n";
  const lines = parts.yaml.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const oldData = fm.data;

  /** Every entry written, as YAML text: what the new data must hold on top of the old. */
  const entries: string[] = [];
  /** The YAML key a top-level line starts, or null. */
  const keyOf = (line: string): string | null => /^([A-Za-z_][\w-]*)[ \t]*:(?=[ \t\r\n]|$)/.exec(line)?.[1] ?? null;
  const indexOfKey = (key: string): number => lines.findIndex((l) => keyOf(l) === key);
  /** One past the last line of the entry that starts at `i`: its indented/list/blank continuation, minus trailing blanks and comments. */
  const endOf = (i: number): number => {
    let end = i + 1;
    while (end < lines.length && /^([ \t]|-([ \t]|\r?\n|$)|#|\r?\n$)/.test(lines[end]!)) end++;
    while (end > i + 1 && /^[ \t]*(#.*)?\r?\n?$/.test(lines[end - 1]!)) end--;
    return end;
  };
  const withEol = (line: string): string => (line.endsWith("\n") ? line : line + eol);
  /** Replace the entry for `key`, else insert `entry` at `at` (a line index; the end by default). */
  const put = (key: string, entry: string, at?: number): void => {
    entries.push(entry);
    const i = indexOfKey(key);
    if (i >= 0) {
      lines.splice(i, endOf(i) - i, withEol(entry));
      return;
    }
    if (lines.length > 0 && !lines[lines.length - 1]!.endsWith("\n")) lines[lines.length - 1] += eol;
    lines.splice(at === undefined ? lines.length : at, 0, withEol(entry));
  };
  /** Index just after the entry of `key`, or 0 when the file has none. */
  const afterKey = (key: string): number => {
    const i = indexOfKey(key);
    return i < 0 ? 0 : endOf(i);
  };

  put("status", `status: ${status}`);
  if (isRun) put("last_run", `last_run: {date: ${date}}`, afterKey("status"));

  const next = parts.head + lines.join("") + parts.tail + parts.body;

  // What the new data must be: the old data with exactly the entries written here changed.
  const expected = { ...oldData, ...((yamlLoad(entries.join(eol)) ?? {}) as Record<string, unknown>) };
  if (sameData(expected, oldData)) return { ok: true, text, changed: false };
  const reparsed = parseFrontmatter(next);
  const newParts = splitFrontmatter(next);
  if (!reparsed.ok || !newParts || newParts.body !== parts.body || !sameData(reparsed.data, expected)) {
    return refuse("unsafe", "could not edit the frontmatter safely (unusual YAML); nothing was written. Fix the frontmatter so it parses as plain top-level YAML keys, then try again");
  }
  return { ok: true, text: next, changed: true };
}

// ── reading ──────────────────────────────────────────────────────────────────────

export type ReadResult = { ok: true; text: string } | { ok: false; reason: TcWriteRefusal; message: string };

/**
 * The text of a TC: opened non-blocking and without following a symlink, checked with fstat on that same
 * descriptor (a FIFO or a link to /dev/zero named TC-*.md must not block the extension host), at most MAX_TC_BYTES.
 * Own copy of the no-follow reader (pending-io.mjs `readRegularFile`): tc-io.ts is not edited for it.
 */
export function readTcFile(file: string): ReadResult {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { ok: false, reason: "symlink", message: "the test case is a symlink; refusing to read or write through it" };
    if (code === "ENOENT") return { ok: false, reason: "not-found", message: "the test case file is not there" };
    return { ok: false, reason: "unreadable", message: `cannot read the test case: ${String((e as Error).message).split("\n")[0]}` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not-regular", message: "the test case is not a regular file" };
    if (st.size > MAX_TC_BYTES) return { ok: false, reason: "too-large", message: `the test case is larger than ${MAX_TC_BYTES} bytes` };
    return { ok: true, text: readFileSync(fd, "utf8") };
  } catch (e) {
    return { ok: false, reason: "unreadable", message: `cannot read the test case: ${String((e as Error).message).split("\n")[0]}` };
  } finally {
    closeSync(fd);
  }
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** The status and last run `text` lists as, the way the board reads a TC file. */
function viewOf(relPath: string, text: string): TcView {
  const fileName = basename(relPath);
  const tc = parseTestCase({ fileName, folder: basename(dirname(relPath)), text, path: relPath });
  return { status: tc.status, lastRun: tc.lastRun ?? null };
}

function sameRun(a: TestCaseRun | null | undefined, b: TestCaseRun | null | undefined): boolean {
  return (a?.date ?? null) === (b?.date ?? null) && (a?.evidence ?? null) === (b?.evidence ?? null);
}

// ── the file writer ──────────────────────────────────────────────────────────────

/** A control character (C0 or DEL) or a backslash: never part of a board path segment. */
function hasControlOrBackslash(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** The path segments of `relPath` when it is `campaigns/<c>/tests/m<n>/TC-*.md`, else null. */
export function tcSegments(relPath: string): string[] | null {
  if (typeof relPath !== "string") return null;
  const segs = relPath.split("/");
  if (segs.length !== 5 || segs[0] !== "campaigns" || segs[2] !== "tests") return null;
  if (segs.some((s) => s === "" || s === "." || s === ".." || hasControlOrBackslash(s))) return null;
  if (!/^m\d+[a-z]*$/.test(segs[3]!) || !/^TC-.*\.md$/.test(segs[4]!)) return null;
  return segs;
}

function refusedWrite(reason: TcWriteRefusal, message: string): WriteTestCaseStatusResult {
  return { ok: false, reason, message };
}

/**
 * Record `opts.status` in the test case at `relPath` (board-relative, `/`-separated: `campaigns/<c>/tests/m<n>/TC-*.md`)
 * under `boardRoot`. Reads the file once (bounded, no symlink followed), checks `opts.expect` against it, computes the
 * edit from those bytes, writes it to a temp file in the same folder (the file's mode kept), re-reads the TC, and renames
 * only when its bytes are still the ones the edit was computed from. Anything else writes nothing and leaves no temp file.
 * The window between that final re-read and the rename is the script's own and accepted: there is no lock file.
 * A TC, `m<n>` folder or `tests` folder that is a symlink is refused (nothing is written through a link), and so is
 * a file that does not resolve to a TC inside the board (a symlinked campaign folder leaving it, say).
 */
export function writeTestCaseStatus(boardRoot: string, relPath: string, opts: WriteTestCaseStatusOptions): WriteTestCaseStatusResult {
  const segs = tcSegments(relPath);
  if (!segs) return refusedWrite("not-a-test-case", `not a test case file (expected campaigns/<campaign>/tests/m<n>/TC-*.md): ${JSON.stringify(relPath)}`);
  const file = join(boardRoot, ...segs);
  const folderDir = dirname(file);
  const testsDir = dirname(folderDir);

  const st = lstatOrNull(file);
  if (!st) return refusedWrite("not-found", `not found: ${relPath}`);
  for (const p of [file, folderDir, testsDir]) {
    if ((p === file ? st : lstatOrNull(p))?.isSymbolicLink()) return refusedWrite("symlink", `refusing to write: ${relPath} is, or sits in, a symlink`);
  }
  if (!st.isFile()) return refusedWrite("not-regular", `not a regular file: ${relPath}`);
  // The three links above are the script's rule; a symlinked campaign folder (or any other ancestor) is caught here:
  // the file must resolve to a TC inside the board, or nothing is written.
  try {
    if (!tcSegments(relative(realpathSync(boardRoot), realpathSync(file)).split(sep).join("/"))) {
      return refusedWrite("symlink", `refusing to write: ${relPath} resolves outside the board's tests folders`);
    }
  } catch (e) {
    return refusedWrite("unreadable", `cannot resolve ${relPath}: ${String((e as Error).message).split("\n")[0]}`);
  }

  const read = readTcFile(file);
  if (!read.ok) return refusedWrite(read.reason, read.message);
  const text = read.text;

  const view = viewOf(relPath, text);
  const { expect } = opts;
  if (expect && !(expect.status === view.status && sameRun(expect.lastRun, view.lastRun))) {
    return { ok: false, reason: "stale", message: "the test case changed since it was read; nothing was written", current: view };
  }
  if (opts.skipIfCurrent && opts.status === view.status) return { ok: true, changed: false };

  const edit = editTestCaseStatus(text, opts.status, opts.date);
  if (!edit.ok) return refusedWrite(edit.reason, edit.message);
  if (!edit.changed) return { ok: true, changed: false };

  const tmp = join(folderDir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    rmSync(tmp, { force: true }); // a leftover (or planted) temp name; `wx` below never writes through a link
    writeFileSync(tmp, edit.text, { flag: "wx" });
    chmodSync(tmp, st.mode & 0o7777);
    opts.beforeFinalRead?.({ file, tmp });
    const again = readTcFile(file);
    if (!again.ok) {
      rmSync(tmp, { force: true });
      return refusedWrite(again.reason, again.message);
    }
    if (again.text !== text) {
      rmSync(tmp, { force: true });
      return { ok: false, reason: "stale", message: "the test case changed while the edit was prepared; nothing was written", current: viewOf(relPath, again.text) };
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the folder may be read-only */
    }
    return refusedWrite("write-failed", `cannot write ${relPath}: ${String((e as Error).message).split("\n")[0]}`);
  }
  return { ok: true, changed: true };
}
