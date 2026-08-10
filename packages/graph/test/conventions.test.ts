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

  /**
   * A third single-spelling rule, of the same shape as `edgeWeight`/`compare`
   * above: whether a path is a test file lives in `isTestPath` (noise.ts) and
   * nowhere else. A hand-rolled test-path regex open-coded at a second call
   * site would agree with `isTestPath` on every fixture right up until one of
   * the two is tweaked and they quietly start disagreeing about which files
   * are tests — precisely the class of mistake that put negative-weight
   * module edges into a committed artifact once already (see the npmi guard
   * above), just for A8's clustering exclusion instead of the nPMI floor.
   *
   * Matched against the ESCAPED form a real regex literal actually uses on
   * disk (`\.test\.`, `\.spec\.`) — not the bare `.test.`/`.spec.` sequence,
   * which a correctly-written regex literal never contains contiguously (the
   * dot before the extension is itself escaped, so a backslash always sits
   * between the marker and the trailing dot). A guard written against the
   * unescaped form would silently never fire against the one thing it exists
   * to catch: a copy of noise.ts's own pattern text pasted somewhere else.
   */
  it("recognises a test path only through isTestPath, never a second hand-rolled pattern", () => {
    const offenders = sources.filter(
      (f) => f !== "noise.ts" && /\\\.test\\\.|\\\.spec\\\.|__tests__/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * A fourth single-spelling rule: where Graphify leaves its output lives in
   * `graphifyGraphPath` (graphify.ts) and nowhere else. `doctor` asks a
   * different question about that same file than `readGraphify` does — "is one
   * there at all", to tell an uninstalled Graphify apart from a run that
   * produced nothing usable — and answered it by re-spelling the path, which
   * is the `edgeWeight` divergence in miniature: two modules, one rule, free
   * to drift the day the output directory is renamed or made configurable.
   *
   * Matched against the raw source with COMMENTS stripped but string literals
   * KEPT — the opposite of `code()` above, because here the literal *is* the
   * violation. Prose about the path (this suite's own fixtures aside) stays
   * exempt.
   */
  it("spells the graphify output path only in graphify.ts", () => {
    const withoutComments = (file: string): string =>
      readFileSync(join(SRC, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
    const offenders = sources.filter(
      (f) => f !== "graphify.ts" && /graphify-out/.test(withoutComments(f)),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * A fifth single-spelling rule, and the one M3 shipped broken: whether a repo
   * has an Octobots board lives in `hasBoard` (artifact.ts) and nowhere else.
   *
   * Two modules ask that question and they must never disagree — `resolveOut`
   * decides where the committed artifact is WRITTEN on the strength of it, and
   * `doctor` grades its "board" check on the strength of it. They arrived from
   * two different task PRs (T3.3 and T3.2) each with its own `existsSync(join(
   * repoRoot, ".octobots"))`, which is the `edgeWeight` divergence again: free
   * to drift the day the directory is renamed or the predicate is tightened,
   * and silent when it does (doctor says "board found"; `map` writes into
   * `.octograph/`).
   *
   * Matched against the BARE path literal — `".octobots"` between quotes —
   * with comments stripped and string literals kept. Prose that names the
   * directory for a human (`".octobots/ found"`, `"plan work onto an
   * .octobots/ board"`) is a message, not a path spelling, and is deliberately
   * not caught: the character after the segment there is `/`, never a quote.
   */
  it("spells the board directory only in artifact.ts", () => {
    const withoutComments = (file: string): string =>
      readFileSync(join(SRC, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
    const offenders = sources.filter(
      (f) => f !== "artifact.ts" && /["'`]\.octobots["'`]/.test(withoutComments(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("never reads a clock or an RNG in graph computation", () => {
    const offenders = sources.filter((f) => /\bDate\.now\s*\(|\bMath\.random\s*\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  /**
   * The same rule, on the other side of the call. `analyze`, `countPairs` and
   * `runCli` all take `now` as a REQUIRED parameter precisely so the clock
   * cannot get into the computation (see cli.ts) — but a test is free to hand
   * them `Date.now()`, and one did: the T7.1 live-history assertion, which
   * measures this repo's own decayed co-change graph and therefore its Louvain
   * partition, from wherever the wall clock happened to be. Nothing about that
   * failure is visible in a green run; it simply means the suite is asserting
   * a slightly different graph every day, and the day the drift crosses a
   * threshold the failure looks like a code regression and is not one.
   *
   * The whole suite already pins an epoch (`Date.UTC(2026, 0, 1)`, per file),
   * which the clock guard here does not touch — `Date.UTC` is a pure function
   * of its arguments. This makes that convention structural instead of
   * remembered. `Math.random` is banned for the same reason: a fixture built
   * from random paths reproduces nothing when it fails.
   */
  it("pins a fixed epoch in tests rather than reading the wall clock", () => {
    const offenders = testFiles.filter((f) =>
      /\bDate\.now\s*\(|\bMath\.random\s*\(/.test(testCode(f)),
    );
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
      // M3's own surface. The list above was M2's, and it is a HARDCODED list:
      // it could not notice that M3 added `drift`, `doctor` and the artifact
      // and CLI entry points, and `runCli` in fact reached this file only in
      // review — the third time this package shipped a module its own
      // consumers could not import. A symbol added to the package's public
      // surface belongs here, in the same commit.
      "drift",
      "doctor",
      "classifyPair",
      "readArtifact",
      "resolveOut",
      "writeArtifact",
      "hasBoard",
      "runCli",
      // M7's own surface, added in the same commit that added it to index.ts —
      // which is the point of a hardcoded list. `workingSets` is the first
      // thing M7 computes and the thing every later task in the mission
      // renders; a consumer outside this package reaches it through
      // `dist/index.js` or not at all.
      "workingSets",
    ]) {
      expect(index).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});
