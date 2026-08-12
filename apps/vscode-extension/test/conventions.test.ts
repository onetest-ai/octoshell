import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The structural backstop for `fixtures/tmpdir.ts`'s `mkdtempClean`, modelled on
 * `packages/graph/test/conventions.test.ts`'s own `mkdtempSync` guard (same defect, same fix,
 * same shape of test — see that file's doc comment for the fuller history).
 *
 * A run of this suite once left 84 temp directories (10.1 MB) behind under the OS temp dir: eleven
 * test files called raw `mkdtempSync` directly, each leaking the fixture it built because nothing
 * removed it. `mkdtempClean` fixes that at the point of creation (`onTestFinished` registers its
 * own removal, so cleanup is not a step a caller can forget) — but nothing stopped a NEW test file,
 * or a re-added call in one of the six files already migrated, from going back to the raw form.
 * This is that enforcement: a raw `mkdtempSync` call anywhere in this directory other than
 * `fixtures/tmpdir.ts` itself fails the build.
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Every `.ts`/`.tsx` file under `dir`, recursively — `test/` is flat today (only `fixtures/` is
 *  a subdirectory), but a guard that only reads `readdirSync(TEST_DIR)` would go blind the day a
 *  new subdirectory appears, which is exactly the shape of hole this rule exists to close. */
function listTestFiles(dir: string, relPrefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relPrefix === "" ? entry.name : join(relPrefix, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(join(dir, entry.name), rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Comments and string literals stripped in ONE left-to-right pass, so a doc comment that names
 * `mkdtempSync` in backticks (several files here explain why they use `mkdtempClean` instead) is
 * never mistaken for a call, and so a string containing `//` — the exact bug that once corrupted
 * `packages/graph`'s own version of this scan — cannot desynchronize a two-pass strip. Regex
 * literals get no special handling: this file never scans for one, so `/` is only ever division or
 * a comment/string delimiter here.
 */
function stripCommentsAndStrings(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    const d = i + 1 < n ? (text[i + 1] as string) : "";
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n) {
        const s = text[i] as string;
        if (s === "\\") {
          i += 2;
          continue;
        }
        i++;
        if (s === c) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function code(file: string): string {
  return stripCommentsAndStrings(readFileSync(join(TEST_DIR, file), "utf8"));
}

const MKDTEMP_SYNC_CALL = /\bmkdtempSync\s*\(/;

describe("test/ conventions", () => {
  const testFiles = listTestFiles(TEST_DIR);

  it("has test files to check", () => {
    expect(testFiles.length).toBeGreaterThan(10);
  });

  /**
   * The regression test for the scanner above: a `//` inside a string must not be read as the
   * start of a comment (the defect that once deleted 150 lines of `packages/graph`'s `setup.ts`
   * out from under its own guards), and a real call must survive the strip untouched.
   */
  it("strips comments and strings without losing real code, and without misreading a // inside a string", () => {
    expect(
      stripCommentsAndStrings('const url = "https://example.com"; mkdtempSync(x);'),
    ).toContain("mkdtempSync(x)");
    expect(stripCommentsAndStrings("// mkdtempSync(x) in a comment\nconst y = 1;")).not.toContain(
      "mkdtempSync",
    );
    expect(
      stripCommentsAndStrings("/* mkdtempSync(x) in a block comment */\nconst y = 1;"),
    ).not.toContain("mkdtempSync");
    expect(stripCommentsAndStrings('const s = "mkdtempSync(x)";')).not.toContain("mkdtempSync");
    // A prose mention with no trailing paren (how every file here now names the banned call in a
    // doc comment) is untouched either way — pinned so the meta-test above stays honest about what
    // it is actually proving.
    expect(stripCommentsAndStrings("// never a bare `mkdtempSync` here\n")).not.toContain(
      "mkdtempSync",
    );
  });

  /**
   * THE regression this suite exists for: a run of this package's tests once left 84 fixture
   * directories (10.1 MB) behind because eleven files called `mkdtempSync` directly instead of
   * through `fixtures/tmpdir.ts`'s self-cleaning `mkdtempClean`. Un-cleaned fixtures pass every
   * assertion the test that built them makes, so this cannot be caught behaviourally — only the
   * source distinguishes a call that cleans up from one that does not.
   */
  it("creates a scratch directory only through fixtures/tmpdir.ts's mkdtempClean", () => {
    const guardFile = join("fixtures", "tmpdir.ts");
    const offenders = testFiles.filter(
      (f) => f !== guardFile && MKDTEMP_SYNC_CALL.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });
});
