// What a test-case panel needs from ONE TC file: the TestCase the board lists, the body to render, whether the file
// is a legacy one, and whether the status can be written. A read; nothing here writes.
//
// The file is read the way `writeTestCaseStatus` reads it (bounded, opened without following a symlink), so a FIFO
// or a link to /dev/zero named TC-*.md never blocks the extension host. A TC that is itself, or sits in, a symlink
// is readable only when it resolves to a TC file inside the board, and is then never writable.
//
// Tree-shaking (campaign octoshell-0-1-1, rule 8): like tc-status.ts, nothing reaches this module from BoardModel
// and its top level holds only imports, type declarations and function declarations (`tc-status-toplevel.test.ts`
// checks both files; `graph-payload.mjs --verify` is the real gate).

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter, splitFrontmatter } from "./tc-io.js";
import { readTcFile, tcSegments } from "./tc-status.js";
import { parseTestCase } from "./test-cases.js";
import type { TestCase } from "./test-cases.js";

/** The body to render: markdown after the frontmatter block, the whole file as plain text, or nothing (over 4 MiB). */
export type TcBody = { kind: "markdown"; text: string } | { kind: "plain"; text: string } | { kind: "too-large" };

/** Whether a status pick can be written, else why not. */
export type TcWritable = { ok: true } | { ok: false; reason: "no-frontmatter" | "unparseable" | "symlink" | "too-large" };

export interface TestCaseFileDetail {
  /** The TC as the board lists it (a file with no readable frontmatter lists with its file-derived fields). */
  tc: TestCase;
  body: TcBody;
  /** The frontmatter parses but `kind` or `mission` is absent from it (the status can still be set). */
  legacy: boolean;
  writable: TcWritable;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function absent(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * The detail of the TC at `relPath` (board-relative, `/`-separated: `campaigns/<c>/tests/m<n>/TC-*.md`) under
 * `boardRoot`, or null: not that shape (`..`, an absolute path, another file), not there, not a regular file, a
 * symlink leaving the board or resolving to something that is not such a TC, or unreadable.
 */
export function readTestCaseDetail(boardRoot: string, relPath: string): TestCaseFileDetail | null {
  const segs = tcSegments(relPath);
  if (!segs) return null;
  const file = join(boardRoot, ...segs);
  const folderDir = dirname(file);
  if (!lstatOrNull(file)) return null;
  const linked = [file, folderDir, dirname(folderDir)].some((p) => lstatOrNull(p)?.isSymbolicLink());

  let real = file;
  if (linked) {
    try {
      real = realpathSync(file);
      const rel = relative(realpathSync(boardRoot), real);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !tcSegments(rel.split(sep).join("/"))) return null;
    } catch {
      return null;
    }
  }

  const fileName = basename(relPath);
  const folder = segs[3]!;
  const read = readTcFile(real);
  if (!read.ok) {
    if (read.reason !== "too-large") return null;
    const tc = parseTestCase({ fileName, folder, text: "", path: relPath });
    return { tc, body: { kind: "too-large" }, legacy: false, writable: { ok: false, reason: linked ? "symlink" : "too-large" } };
  }

  const text = read.text;
  const tc = parseTestCase({ fileName, folder, text, path: relPath });
  const parts = splitFrontmatter(text);
  const fm = parseFrontmatter(text);
  const body: TcBody = !parts ? { kind: "plain", text } : { kind: "markdown", text: fm.body };
  let writable: TcWritable = { ok: true };
  if (linked) writable = { ok: false, reason: "symlink" };
  else if (!parts) writable = { ok: false, reason: "no-frontmatter" };
  else if (!fm.ok) writable = { ok: false, reason: "unparseable" };
  const legacy = fm.ok && (absent(fm.data.kind) || absent(fm.data.mission));
  return { tc, body, legacy, writable };
}
