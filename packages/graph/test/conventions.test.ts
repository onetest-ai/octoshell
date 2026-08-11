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
    ]) {
      expect(index).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
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
