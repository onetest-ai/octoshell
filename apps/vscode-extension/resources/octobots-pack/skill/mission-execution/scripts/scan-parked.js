#!/usr/bin/env node
// scan-parked.js: find tests parked instead of fixed (skipped, xfailed, todo) in a repo.
//
//   node scan-parked.js [--root <dir>] [--json]
//
// The file set is what `git ls-files` lists under --root (default: the current directory) that
// matches a test glob: *.test.*, *.spec.*, test_*.py, *_test.py, or a source file (.ts .tsx .js
// .jsx .mjs .cjs .mts .cts .py) under a tests/ or test/ directory. A test directory also holds prose
// and data (a test-case README, a JSON fixture) that may MENTION `.skip(` without parking anything,
// so only source files count there. node_modules/ and dist/ (at any depth) and this script's own test fixtures
// (a fixtures/scan-parked/ directory) are never scanned. Untracked files are not scanned.
//
// Unsigned hits (one entry per line, however many tokens it holds):
//   - pytest `@pytest.mark.xfail` / `@pytest.mark.skip` without `reason=` (the decorator's
//     arguments may span lines; the hit is on the decorator's own line);
//   - an imperative `pytest.xfail(` or `pytest.skip(` call, reason or not;
//   - vitest/jest `.skip(`, `.todo(`, `.fails(`, `xit(` and `xdescribe(` as call tokens. A token
//     is a call, so `process.exit(` and any identifier that merely ends in `xit` is no hit.
// Allowed (listed, never failing): `.skipIf(` / `.runIf(`, pytest `skipif` with a `reason=`, and a
// pytest `xfail` / `skip` marker that states `reason=`. A `skipif` with no reason is unsigned: the
// only skip allowed is one with a stated reason.
//
// A line `<path>:<line> <who> <YYYY-MM-DD>` in `<root>/.octobots/parked-signoff.txt` exempts the
// hit at that path and line: it moves to `allowed`. Blank lines and `#` comments are ignored; a
// malformed line signs nothing.
//
// Exit 0 when no unsigned hit remains, 1 otherwise, 2 on a usage error, a --root that is not a
// directory, or a root that is not inside a git repository. `--json` prints
// {"unsigned": [{file, line, text}], "allowed": [{file, line, text}]} on stdout; notes about files
// that could not be scanned go to stderr either way.
//
// Every file is opened non-blocking and without following a symlink, then checked with fstat on
// that descriptor, and read only when it is a regular, non-binary file of at most 2 MiB: a FIFO
// at a tracked path, a symlink to /dev/zero or a huge file cannot hang or flood the scan.
import { execFileSync } from "node:child_process";
import { closeSync, constants as fsc, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const USAGE = "usage: scan-parked.js [--root <dir>] [--json]";
const SIGNOFF_FILE = ".octobots/parked-signoff.txt";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SIGNOFF_BYTES = 1024 * 1024;
const MAX_TEXT = 200;
const MAX_DECORATOR_LINES = 20;

const fail = (code, message) => {
  process.stderr.write(`scan-parked: ${message}\n`);
  process.exit(code);
};

// ── arguments ─────────────────────────────────────────────────────────────────────────────────
let rootArg;
let json = false;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--root") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) fail(2, `--root needs a directory\n${USAGE}`);
      rootArg = v;
    } else fail(2, `unexpected argument ${JSON.stringify(a)}\n${USAGE}`);
  }
}
const root = resolve(rootArg ?? process.cwd());
try {
  if (!statSync(root).isDirectory()) throw new Error("not a directory");
} catch {
  fail(2, `--root ${root} is not a directory`);
}

// ── the file set ──────────────────────────────────────────────────────────────────────────────
function trackedFiles() {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\0").filter(Boolean);
  } catch (err) {
    if (err && err.code === "ENOENT") fail(2, "git was not found on PATH; it is needed to list the tracked files");
    return fail(2, `${root} is not a git repository (git ls-files failed); nothing to scan`);
  }
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;
const isTestFile = (path) => {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  if (/^.+\.(test|spec)\..+$/.test(base) || /^test_.*\.py$/.test(base) || /^.+_test\.py$/.test(base)) return true;
  return SOURCE_FILE.test(base) && parts.slice(0, -1).some((d) => d === "test" || d === "tests");
};
const isExcluded = (path) =>
  path.split("/").slice(0, -1).some((d) => d === "node_modules" || d === "dist") || `/${path}`.includes("/fixtures/scan-parked/");

// ── reading ───────────────────────────────────────────────────────────────────────────────────
const notes = [];
/** The text of a regular file of at most `max` bytes, or null (with a note unless the file is just absent). */
function readText(abs, label, max) {
  let fd;
  try {
    fd = openSync(abs, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0) | (fsc.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    notes.push(`${label}: not read (${err.code === "ELOOP" ? "a symlink" : err.code ?? "unreadable"})`);
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) { notes.push(`${label}: not read (not a regular file)`); return null; }
    if (st.size > max) { notes.push(`${label}: not read (larger than ${max} bytes)`); return null; }
    const buf = readFileSync(fd);
    if (buf.subarray(0, 8000).includes(0)) { notes.push(`${label}: not read (binary)`); return null; }
    return buf.toString("utf8");
  } catch (err) {
    notes.push(`${label}: not read (${err.code ?? "unreadable"})`);
    return null;
  } finally {
    closeSync(fd);
  }
}

// ── the hit rules ─────────────────────────────────────────────────────────────────────────────
const PYTEST_MARKER = /@pytest\.mark\.(xfail|skipif|skip)\b/;
const PYTEST_CALL = /\bpytest\.(?:xfail|skip)\s*\(/;
const JS_CALL = /\.(?:skip|todo|fails)\s*\(|(?<![\w$.])(?:xit|xdescribe)\s*\(/;
const ALLOWED_CALL = /\.(?:skipIf|runIf)\s*\(/;

/** The text of a decorator's `( ... )` argument list, which may span lines; "" when it has none. */
function decoratorArgs(lines, i, from) {
  const first = lines[i].slice(from);
  if (!/^\s*\(/.test(first)) return "";
  let depth = 0;
  let text = "";
  for (let n = i; n < lines.length && n < i + MAX_DECORATOR_LINES; n++) {
    const chunk = n === i ? first : lines[n];
    for (const ch of chunk) {
      text += ch;
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return text;
    }
    text += "\n";
  }
  return text;
}

/** "unsigned", "allowed" or null for line `i` of a file. */
function classify(lines, i) {
  const line = lines[i];
  const marker = PYTEST_MARKER.exec(line);
  if (marker) {
    const args = decoratorArgs(lines, i, marker.index + marker[0].length);
    return /\breason\s*=/.test(args) ? "allowed" : "unsigned";
  }
  if (PYTEST_CALL.test(line) || JS_CALL.test(line)) return "unsigned";
  return ALLOWED_CALL.test(line) ? "allowed" : null;
}

// ── signoff ───────────────────────────────────────────────────────────────────────────────────
const validDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
function readSignoffs() {
  const signed = new Set();
  const text = readText(join(root, SIGNOFF_FILE), SIGNOFF_FILE, MAX_SIGNOFF_BYTES);
  if (text === null) return signed;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\S+):(\d+)[ \t]+(\S+)[ \t]+(\d{4}-\d{2}-\d{2})$/.exec(raw.trim());
    if (m && validDate(m[4])) signed.add(`${m[1].replace(/\\/g, "/").replace(/^(\.\/)+/, "")}:${Number(m[2])}`);
  }
  return signed;
}

// ── scan ──────────────────────────────────────────────────────────────────────────────────────
const signed = readSignoffs();
const unsigned = [];
const allowed = [];
for (const file of trackedFiles().filter((f) => isTestFile(f) && !isExcluded(f)).sort()) {
  const text = readText(join(root, file), file, MAX_FILE_BYTES);
  if (text === null) continue;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kind = classify(lines, i);
    if (kind === null) continue;
    const trimmed = lines[i].trim();
    const hit = { file, line: i + 1, text: trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT - 3) + "..." : trimmed };
    (kind === "unsigned" && !signed.has(`${file}:${i + 1}`) ? unsigned : allowed).push(hit);
  }
}

for (const n of notes) process.stderr.write(`scan-parked: ${n}\n`);
if (json) {
  process.stdout.write(`${JSON.stringify({ unsigned, allowed }, null, 2)}\n`);
} else {
  const show = (title, hits) => hits.length ? `${title} (${hits.length}):\n${hits.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join("\n")}\n` : "";
  process.stdout.write(
    `scan-parked: ${root}\n${show("unsigned", unsigned)}${show("allowed", allowed)}` +
      `${unsigned.length} unsigned, ${allowed.length} allowed\n` +
      (unsigned.length ? `Fix each one, or sign it off in ${SIGNOFF_FILE} as: <path>:<line> <who> <YYYY-MM-DD>\n` : ""),
  );
}
process.exitCode = unsigned.length ? 1 : 0;
