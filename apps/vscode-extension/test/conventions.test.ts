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

/**
 * M6 T6.4 review: the webview bundle must not reach into `src/host/` (extension-host, Node side). Shared, pure
 * code lives in `src/protocol/`. A host import from the webview is one edit away from pulling Node APIs into the
 * vite bundle, so the boundary is enforced here rather than by convention.
 */
describe("webview/host boundary", () => {
  const WEBVIEW_DIR = join(TEST_DIR, "..", "src", "webview");
  it("no src/webview file imports from src/host", () => {
    const offenders = listTestFiles(WEBVIEW_DIR).filter((rel) =>
      /from\s+["'](\.\.\/)+host\/|import\(\s*["'](\.\.\/)+host\//.test(readFileSync(join(WEBVIEW_DIR, rel), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the shared protocol modules import nothing Node-only", () => {
    const PROTOCOL_DIR = join(TEST_DIR, "..", "src", "protocol");
    const offenders = listTestFiles(PROTOCOL_DIR).filter((rel) =>
      /from\s+["'](node:|fs["']|path["']|os["']|child_process["']|vscode["'])/.test(readFileSync(join(PROTOCOL_DIR, rel), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});


/**
 * T1.2: `src/protocol` and `src/webview` take only TYPES from `@octoshell/board`. The webview bundle must not pull
 * the board library (Node `fs`, js-yaml) into vite, and the protocol is shared with it, so a value import (even a
 * constant such as a status list) is one edit away from that. Use `import type`, or a local zod enum.
 * Scans the raw source line-wise: a multi-line `import { ... } from "@octoshell/board"` and `export ... from`
 * re-exports count; `import type` and `export type` do not.
 */
describe("protocol and webview take only types from @octoshell/board", () => {
  const SRC_DIR = join(TEST_DIR, "..", "src");

  /** The statements in `source` that import or re-export `@octoshell/board` as a VALUE (a bare, dynamic or require import counts). */
  function valueBoardImports(source: string): string[] {
    const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
    const hits: string[] = [];
    for (const m of uncommented.matchAll(/(^|\n)[ \t]*(import|export)\b([^;]*?)["']@octoshell\/board["']/g)) {
      if (!/^\s+type\b/.test(m[3]!) && !/^\s*type\s*\{/.test(m[3]!)) hits.push(m[0].trim());
    }
    for (const m of uncommented.matchAll(/(?:import|require)\(\s*["']@octoshell\/board["']\s*\)/g)) hits.push(m[0]);
    return hits;
  }

  it("the scan itself: flags value, bare, inline-type, dynamic and re-export forms; passes type-only forms", () => {
    const bad = [
      'import { MAX_TC_BYTES } from "@octoshell/board";',
      'import {\n  MAX_TC_BYTES,\n} from "@octoshell/board";',
      'import "@octoshell/board";',
      'import * as board from "@octoshell/board";',
      'import Board, { type TestCase } from "@octoshell/board";',
      'export { parseTestCase } from "@octoshell/board";',
      'export * from "@octoshell/board";',
      'const b = await import("@octoshell/board");',
    ];
    for (const src of bad) expect(valueBoardImports(src), src).not.toEqual([]);
    const good = [
      'import type { TestCase } from "@octoshell/board";',
      'import type {\n  TestCase,\n  Mission,\n} from "@octoshell/board";',
      'export type { TestCase } from "@octoshell/board";',
      '// import { x } from "@octoshell/board"\n/* import { y } from "@octoshell/board" */',
      'import { z } from "zod";',
    ];
    for (const src of good) expect(valueBoardImports(src), src).toEqual([]);
  });

  it("no src/protocol or src/webview file value-imports @octoshell/board", () => {
    const offenders: string[] = [];
    for (const dir of ["protocol", "webview"]) {
      for (const rel of listTestFiles(join(SRC_DIR, dir))) {
        for (const hit of valueBoardImports(readFileSync(join(SRC_DIR, dir, rel), "utf8"))) offenders.push(`${dir}/${rel}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * turbo runs tasks in strict env mode: a variable not declared in `turbo.json` never reaches
 * vitest under `pnpm test` / `pnpm coverage`. These are the env inputs tests read, so each must
 * stay declared or the real-board / real-ccusage checks silently fall back to the default path
 * (0.1.1 M1 B2).
 */
describe("turbo.json env passthrough", () => {
  const turbo = JSON.parse(
    readFileSync(join(TEST_DIR, "..", "..", "..", "turbo.json"), "utf8"),
  ) as { globalPassThroughEnv?: string[]; tasks?: Record<string, { passThroughEnv?: string[] }> };
  const passed = new Set([
    ...(turbo.globalPassThroughEnv ?? []),
    ...(turbo.tasks?.test?.passThroughEnv ?? []),
  ]);

  it.each(["OCTOBOTS_BOARD_COPIES", "OCTOBOTS_TOKENOMICS_COPY", "OCTOBOTS_REAL_CCUSAGE"])(
    "passes %s through to the test task",
    (name) => {
      expect(passed.has(name)).toBe(true);
    },
  );
});
