#!/usr/bin/env node
import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dump as yamlDump, load as yamlLoad } from "./vendor/js-yaml.mjs";
import { MAX_TC_BYTES, TC_ID_RE, coversOf, missionIdOfFolder, parseFrontmatter, splitFrontmatter } from "./tc-io.mjs";
import { readRegularFile } from "./pending-io.mjs";

// Record a test case's result on the board: write `status` (and `last_run`) into a TC file's frontmatter.
//
// Usage:
//   set-test-status.js <tc-file> <pass|fail|blocked|draft|ready> [--evidence <path>] [--date YYYY-MM-DD]
//   set-test-status.js <tc-file> --migrate [<pass|fail|blocked|draft|ready>] [--evidence <path>] [--date YYYY-MM-DD]
//
// <tc-file> is `<campaign>/tests/m<n>/TC-*.md`. Result words map to statuses: PASS -> pass, FAIL -> fail,
// BLOCKED and UNREACHABLE -> blocked (the reason goes in the RUN file). `unknown` is never accepted as a
// status: only `--migrate` with no status writes it (it is what a file with no recorded status lists as).
//
// last_run: pass, fail and blocked are runs, so they write `last_run: {date, evidence}` (replacing the old
// one wholesale: a stale evidence path must not outlive the run it described). `draft` and `ready` are
// authoring states, not runs: they leave last_run alone, and --date/--evidence are refused with them.
// --date defaults to today in UTC (as set-status.js dates its override note); --evidence is a repo-relative
// path (no `..`, not absolute), usually the RUN file.
//
// --migrate adds the missing TC-format-contract fields to a legacy file (id from the filename, title from
// the H1, mission from the m<n> folder, covers from `requirements`) and, when the file has no status, sets
// `status: unknown`; an existing status is never changed unless a status is given. `kind` is not guessed.
// A file with NO frontmatter gets a new block (id, title, mission, status) in front of its text; without
// --migrate such a file is refused. A file whose frontmatter does not parse is always refused: nothing is guessed.
//
// Only frontmatter lines change: the status/last_run lines are replaced in place and the migrated fields
// inserted, so comments, key order, dates, line endings and every other key survive, and the body is
// byte-identical. The result is re-parsed and compared with the old data before anything is written.
// Idempotent: when nothing would change, nothing is written ("(already)"). The write is atomic (temp file
// in the same folder, renamed over the TC), and a TC, tests/m<n>/ or tests/ that is a symlink is refused.
// Exit codes: 0 done (or nothing to do); 2 on any usage error, invalid status/date/evidence, a path that is
// not a TC file, a refusal, or a failed write.

const RUN_STATUSES = ["pass", "fail", "blocked"];
const AUTHORING_STATUSES = ["draft", "ready"];
const SETTABLE = [...RUN_STATUSES, ...AUTHORING_STATUSES];
const USAGE = `usage: set-test-status.js <tc-file> <${SETTABLE.join("|")}> [--evidence <path>] [--date YYYY-MM-DD]
       set-test-status.js <tc-file> --migrate [<${SETTABLE.join("|")}>]`;

function fail(msg, withUsage = false) {
  console.error(`set-test-status: ${msg}${withUsage ? `\n${USAGE}` : ""}`);
  process.exit(2);
}

// ── arguments ────────────────────────────────────────────────────────────────────

const positional = [];
let migrate = false;
let evidence = null;
let date = null;
{
  const argv = process.argv.slice(2);
  const valueOf = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`, true);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--migrate") migrate = true;
    else if (a === "--evidence" || a === "--date") {
      const v = valueOf(a, i++);
      if (a === "--evidence") evidence = v; else date = v;
    } else if (a.startsWith("--evidence=")) evidence = a.slice("--evidence=".length);
    else if (a.startsWith("--date=")) date = a.slice("--date=".length);
    else if (a.startsWith("--")) fail(`unknown option ${a}`, true);
    else positional.push(a);
  }
}
const [tcArg, statusArg, ...extra] = positional;
if (!tcArg || extra.length > 0 || (!migrate && statusArg === undefined)) fail("expected <tc-file> and a status", true);

let status = statusArg ?? null; // null: --migrate with no status
if (status !== null && !SETTABLE.includes(status)) {
  if (status === "unknown") {
    fail(migrate ? "`unknown` is never given: omit the status and --migrate lists the file as unknown" : "only --migrate writes unknown (a file with no recorded status lists as unknown); pass one of " + SETTABLE.join(", "));
  }
  fail(`invalid status "${status}" (expected one of: ${SETTABLE.join(", ")})`, true);
}
const isRun = status !== null && RUN_STATUSES.includes(status);
if (!isRun && (evidence !== null || date !== null)) fail("--evidence and --date only apply to pass, fail or blocked (a run)", true);

if (date !== null) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!valid) fail(`--date "${date}" is not a calendar day as YYYY-MM-DD`);
}
if (evidence !== null) {
  // A repo-relative path, as the TC format contract says; it is data in the TC (never opened here), but it must not point outside the repo.
  const bad = evidence === "" || /[\u0000-\u001f\u007f\\]/.test(evidence) || isAbsolute(evidence) || /^[A-Za-z]:/.test(evidence) || evidence.split("/").includes("..");
  if (bad) fail(`--evidence "${evidence.replace(/[\u0000-\u001f\u007f]/g, "?")}" must be a repo-relative path with no .. and no backslash`);
}
const runDate = date ?? new Date().toISOString().slice(0, 10);

// ── the file ─────────────────────────────────────────────────────────────────────

const file = resolve(tcArg);
const folderDir = dirname(file);
const testsDir = dirname(folderDir);
if (!/^TC-.*\.md$/.test(basename(file)) || !/^m\d+[a-z]*$/.test(basename(folderDir)) || basename(testsDir) !== "tests") {
  const exists = lstatOrNull(file);
  fail(`not a test case file (expected <campaign>/tests/m<n>/TC-*.md): ${tcArg}${exists ? "" : " (and not found)"}`);
}
const st = lstatOrNull(file);
if (!st) fail(`not found: ${tcArg}`);
for (const p of [file, folderDir, testsDir]) {
  const s = p === file ? st : lstatOrNull(p);
  if (s?.isSymbolicLink()) fail(`refusing to write: ${relative(dirname(testsDir), p)} is a symlink (${p})`);
}
if (!st.isFile()) fail(`not a regular file: ${tcArg}`);

let text;
try {
  text = readRegularFile(file, { max: MAX_TC_BYTES, noFollow: true });
} catch (e) {
  fail(`cannot read ${tcArg}: ${String(e.message).split("\n")[0]}`);
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

// ── editing the frontmatter lines ────────────────────────────────────────────────

const parts = splitFrontmatter(text);
const fm = parseFrontmatter(text);
if (parts && !fm.ok) fail(`the frontmatter of ${tcArg} is unparseable (nothing is guessed; fix the YAML first)`);
if (!parts && !migrate) fail(`${tcArg} has no frontmatter: run set-test-status.js ${tcArg} --migrate${status ? ` ${status}` : ""} to add it`);

const eol = /\r\n/.test(parts ? parts.yaml + parts.head : text) ? "\r\n" : "\n";
const lines = (parts ? parts.yaml : "").match(/[^\n]*\n|[^\n]+$/g) ?? [];
const oldData = fm.ok ? fm.data : {};

/** Every entry written, as YAML text: what the new data must hold on top of the old. */
const entries = [];
/** The YAML key a top-level line starts, or null. */
const keyOf = (line) => /^([A-Za-z_][\w-]*)[ \t]*:(?=[ \t\r\n]|$)/.exec(line)?.[1] ?? null;
const indexOfKey = (key) => lines.findIndex((l) => keyOf(l) === key);
/** One past the last line of the entry that starts at `i`: its indented/list/blank continuation, minus trailing blanks and comments. */
function endOf(i) {
  let end = i + 1;
  while (end < lines.length && /^([ \t]|-([ \t]|\r?\n|$)|#|\r?\n$)/.test(lines[end])) end++;
  while (end > i + 1 && /^[ \t]*(#.*)?\r?\n?$/.test(lines[end - 1])) end--;
  return end;
}
function withEol(line) {
  return line.endsWith("\n") ? line : line + eol;
}
/** `key: value` as one YAML line, quoted as the value needs. */
const scalarLine = (key, value) => yamlDump({ [key]: value }, { lineWidth: -1 }).trimEnd();
/** Replace the entry for `key`, else insert `entry` at `at` (a line index, or a function of the lines). */
function put(key, entry, at) {
  entries.push(entry);
  const i = indexOfKey(key);
  if (i >= 0) {
    lines.splice(i, endOf(i) - i, withEol(entry));
    return;
  }
  if (lines.length > 0 && !lines[lines.length - 1].endsWith("\n")) lines[lines.length - 1] += eol;
  lines.splice(at === undefined ? lines.length : at, 0, withEol(entry));
}
/** Index just after the entry of `key`, or 0 when the file has none. */
const afterKey = (key) => { const i = indexOfKey(key); return i < 0 ? 0 : endOf(i); };

const folder = basename(folderDir);
const stem = basename(file).replace(/\.md$/, "");
const body = parts ? parts.body : text;
const missing = (key) => oldData[key] === undefined || oldData[key] === null;

if (migrate) {
  const idFromName = stem.split("_")[0];
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body)?.[1] ?? null;
  if (missing("id") && TC_ID_RE.test(idFromName)) put("id", scalarLine("id", idFromName), 0);
  if (missing("title") && h1) put("title", scalarLine("title", h1), afterKey("id"));
  if (missing("mission")) put("mission", scalarLine("mission", missionIdOfFolder(folder)), afterKey("title") || afterKey("id"));
  if (missing("covers") && Array.isArray(oldData.requirements)) {
    // The legacy alias becomes the contract key: only the key token changes, so the list keeps its spelling.
    const i = indexOfKey("requirements");
    if (i >= 0) lines[i] = lines[i].replace(/^requirements/, "covers");
  }
  if (status === null && missing("status")) status = "unknown";
}
if (status !== null) {
  put("status", `status: ${status}`);
  if (isRun) {
    const ev = evidence === null ? "" : `, evidence: ${yamlDump(evidence, { lineWidth: -1 }).trimEnd()}`;
    put("last_run", `last_run: {date: ${runDate}${ev}}`, afterKey("status"));
  }
}

// ── check, then write ────────────────────────────────────────────────────────────

const yamlText = lines.join("");
const head = parts ? parts.head : "---" + eol;
const tail = parts ? parts.tail : "---" + eol;
const next = parts ? head + yamlText + tail + parts.body : head + yamlText + tail + text;

/** A comparable form: dates as ISO strings, mapping keys sorted. */
function canon(v) {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const reparsed = parseFrontmatter(next);
const newParts = splitFrontmatter(next);
// What the new data must be: the old data with exactly the entries written here (and the covers rename) changed.
const expected = { ...oldData, ...(entries.length > 0 ? yamlLoad(entries.join(eol)) : {}) };
if (migrate && missing("covers") && Array.isArray(oldData.requirements)) {
  expected.covers = oldData.requirements;
  delete expected.requirements;
}
const noChange = same(expected, oldData);
if (noChange) {
  report(true);
  process.exit(0);
}
if (!reparsed.ok || !newParts || newParts.body !== body || !same(reparsed.data, expected)) {
  fail(`could not edit the frontmatter of ${tcArg} safely (unusual YAML); nothing was written. Edit it by hand, keeping the TC format contract in mission-planner`);
}

const tmp = join(folderDir, `.${basename(file)}.${process.pid}.tmp`);
try {
  rmSync(tmp, { force: true }); // a leftover (or planted) temp name; `wx` below never writes through a link
  writeFileSync(tmp, next, { flag: "wx" });
  chmodSync(tmp, st.mode & 0o7777);
  renameSync(tmp, file);
} catch (e) {
  try { rmSync(tmp, { force: true }); } catch { /* the folder may be read-only */ }
  fail(`cannot write ${tcArg}: ${String(e.message).split("\n")[0]}`);
}
report(false);

function report(already) {
  const now = parseFrontmatter(already ? text : next);
  const d = now.ok ? now.data : {};
  const run = d.last_run && typeof d.last_run === "object" ? d.last_run : null;
  const when = run ? `, last_run ${run.date instanceof Date ? run.date.toISOString().slice(0, 10) : run.date}${run.evidence ? ` (${run.evidence})` : ""}` : "";
  console.log(`set-test-status: ${basename(file)} status ${d.status ?? "unknown"}${when}${already ? " (already)" : ""}`);
}
