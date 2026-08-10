import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Two rules in this package are single-spelling rules: the nPMI floor lives in
 * `edgeWeight`, and module-name ordering lives in `compare`. Both were
 * open-coded before and diverged immediately — the floor at four call sites in
 * three modules, one of which summed the raw signed value and emitted negative
 * module edges into a committed artifact.
 *
 * Those divergences cannot be caught behaviourally: `Math.max(0, e.npmi)` and
 * `edgeWeight(e)` agree on every value `weighEdges` can produce, so a test that
 * runs the code passes either way. Only the source distinguishes them. Hence a
 * source-level guard — the cheapest thing that makes "read it through the
 * helper" a rule the build enforces rather than a rule reviewers must remember.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const TEST = dirname(fileURLToPath(import.meta.url));

/** Comments and string literals stripped, so prose about a rule is not
 *  mistaken for a violation of it. */
function stripped(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** Source with comments and string literals removed, so prose about a rule is
 *  not mistaken for a violation of it. */
function code(file: string): string {
  return stripped(readFileSync(join(SRC, file), "utf8"));
}

/** Same, for a file under `test/` — `file` may include a subdirectory
 *  (`fixtures/repo.ts`), since `listTs` below walks recursively. */
function testCode(file: string): string {
  return stripped(readFileSync(join(TEST, file), "utf8"));
}

/** All `.ts` files under `dir`, recursively — this suite's test tree is flat
 *  enough (one `fixtures/` subdirectory) that a full walk costs nothing. */
function listTs(dir: string, relPrefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relPrefix === "" ? entry.name : join(relPrefix, entry.name);
    if (entry.isDirectory()) out.push(...listTs(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const testFiles = listTs(TEST);

describe("package conventions", () => {
  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("reads Edge.npmi only in weights.ts, where edgeWeight applies the floor", () => {
    // components.ts writes `npmi:` when it mints a synthetic bridge edge; that
    // is construction, not a weight read, so only property ACCESS is banned.
    const offenders = sources.filter((f) => f !== "weights.ts" && /\.npmi\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("never orders names by locale collation", () => {
    const offenders = sources.filter((f) => /\blocaleCompare\s*\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("never reads a clock or an RNG in graph computation", () => {
    const offenders = sources.filter((f) => /\bDate\.now\s*\(|\bMath\.random\s*\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  /**
   * Cross-package consumers read `dist/index.js` (package.json `exports`),
   * never a deep path into `src/` — so a module that index.ts does not
   * re-export does not exist outside this package, however complete it is.
   * M2 built the whole analysis pipeline across four task PRs and none of them
   * reached index.ts: `analyze`, `renderMap`, `impact` and `loadConfig` were
   * importable only from inside the package's own tests, which is precisely why
   * every per-task suite stayed green over the gap.
   *
   * Asserted on the source rather than by importing the built `dist/`, so the
   * check does not depend on build order (see CLAUDE.md's dist-before-typecheck
   * hazard).
   */
  /**
   * The regression this test exists for: NOTHING in this suite ever removed a
   * fixture repo it built. 31 `buildRepo` call sites plus several more direct
   * `mkdtempSync` calls each leave behind their own `.git` object database,
   * forever — invisible on a dev machine's large, never-inspected temp
   * filesystem, fatal on CI's bounded one, where `git add`'s own temporary
   * index file eventually fails to create ("No such file or directory").
   *
   * The fix is `fixtures/tmpdir.ts`'s `mkdtempClean`, which registers its own
   * `onTestFinished` removal at the point of creation — cleanup becomes a
   * property of creating the directory, not a step 31+ call sites (and every
   * future one) must remember to add. This is that guarantee's structural
   * backstop: a call to raw `mkdtempSync` anywhere else in this suite is
   * exactly the kind of divergence `edgeWeight`/`compare` above exist to
   * catch, and cannot be caught behaviourally — an un-cleaned fixture passes
   * every assertion the test that built it makes.
   */
  it("creates a scratch directory only through fixtures/tmpdir.ts's mkdtempClean", () => {
    const guardFile = join("fixtures", "tmpdir.ts");
    const offenders = testFiles.filter(
      (f) => f !== guardFile && /\bmkdtempSync\s*\(/.test(testCode(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("re-exports the analysis pipeline from index.ts", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    for (const symbol of [
      "harvest",
      "loadConfig",
      "analyze",
      "renderMap",
      "impact",
      "declaredSpine",
      "readGraphify",
      "layerRanks",
      "rollUp",
    ]) {
      expect(index).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});
