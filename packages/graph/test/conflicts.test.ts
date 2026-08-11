import { describe, expect, it } from "vitest";
import type { Analysis } from "../src/analyze.js";
import type { BoardTask } from "../src/board.js";
import { conflicts as conflictReport, type ConflictPair } from "../src/conflicts.js";
import type { Edge } from "../src/weights.js";

/** The `pairs` half of a {@link conflictReport}, for the assertions that
 *  predate its coverage fields — every one of them is about which PAIRS come
 *  out, and reading `.pairs` at each of ~15 call sites would say nothing the
 *  name does not. The coverage half has its own tests at the bottom of this
 *  file, and they call `conflictReport` directly. */
function conflicts(...args: Parameters<typeof conflictReport>): ConflictPair[] {
  return conflictReport(...args).pairs;
}

/** `conflicts` only ever reads `analysis.modules` — every other field is
 *  filled with an inert placeholder so a test can hand in just the module
 *  list it cares about, exactly as `analyze()` would eventually produce it,
 *  without asserting anything about the rest of `Analysis`. */
function moduleAnalysis(modules: Analysis["modules"]): Analysis {
  return {
    commitCount: 0,
    fileCount: 0,
    spineSource: "directories",
    modules,
    moduleEdges: [],
    moduleEdgesDirected: false,
    hubs: [],
    bridged: 0,
    clusterIds: { kept: 0, fresh: 0 },
    workingSets: [],
  };
}

const edge = (a: number, b: number, npmi: number, support = 8): Edge => ({
  a,
  b,
  support,
  npmi,
  confidence: 0.7,
});

const task = (overrides: Partial<BoardTask> & { id: string; criteria: string[] }): BoardTask => ({
  name: overrides.id,
  mission: "m1",
  campaign: "c1",
  ...overrides,
});

describe("conflicts", () => {
  /** The corpus and module map shared by the "shared file" / "coupled files"
   *  pair of tests below — both exercise the same fixture from different
   *  angles, so building it once keeps the token-overlap arithmetic (see the
   *  inline notes) in one place. */
  function ownershipFixture() {
    const files = [
      "src/auth/session.ts",
      "src/billing/invoice.ts",
      "src/billing/ledger.ts",
      "docs/readme.md",
    ];
    const analysis = moduleAnalysis([
      { id: 0, name: "src/auth", members: ["src/auth/session.ts"], layer: null },
      {
        id: 1,
        name: "src/billing",
        members: ["src/billing/invoice.ts", "src/billing/ledger.ts"],
        layer: null,
      },
      { id: 2, name: "docs", members: ["docs/readme.md"], layer: null },
    ]);
    // session.ts (0) <-> invoice.ts (1): real, positive coupling.
    const edges = [edge(0, 1, 0.8)];

    // Two tasks that both predict `session.ts` and nothing else — "auth" and
    // "session" are the only tokens their criteria share with any candidate,
    // and both are unique to session.ts's own path tokens.
    const taskA = task({
      id: "t-a",
      criteria: ["the auth session token is validated"],
    });
    const taskB = task({
      id: "t-b",
      criteria: ["the auth session token is validated"],
    });
    // Predicts `invoice.ts` uniquely: "billing" (shared with ledger.ts too,
    // but at half the idf weight) plus "invoice" (unique) beats ledger.ts's
    // "billing"-only overlap.
    const taskC = task({
      id: "t-c",
      criteria: ["the billing invoice totals are correct"],
    });

    return { files, analysis, edges, taskA, taskB, taskC };
  }

  it("reports a file both tasks predict in shared, ranked above a pair with none", () => {
    const { files, analysis, edges, taskA, taskB, taskC } = ownershipFixture();
    const pairs = conflicts(analysis, edges, files, [taskA, taskB, taskC]);

    const ab = pairs.find((p) => p.a === "t-a" && p.b === "t-b");
    expect(ab?.shared).toEqual(["src/auth/session.ts"]);
    // Both tasks predict only session.ts, so there is no OTHER file to pair
    // it against — coupled stays 0 for this pair specifically.
    expect(ab?.coupled).toBe(0);
    expect(ab?.modules).toEqual(["src/auth"]);

    // Ranked strictly above every pair whose `shared` is empty, regardless
    // of that pair's own `coupled` score.
    const abIndex = pairs.findIndex((p) => p.a === "t-a" && p.b === "t-b");
    const acIndex = pairs.findIndex((p) => p.a === "t-a" && p.b === "t-c");
    expect(abIndex).toBeLessThan(acIndex);
  });

  it("reports coupled > 0 with shared empty for distinct files that historically co-change", () => {
    const { files, analysis, edges, taskA, taskC } = ownershipFixture();
    const pairs = conflicts(analysis, edges, files, [taskA, taskC]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: "t-a", b: "t-c", shared: [] });
    expect(pairs[0]?.coupled).toBeGreaterThan(0);
    // Different declared modules (src/auth vs src/billing) — nothing
    // contended, which is exactly the case `coupled` exists to catch that
    // `shared` cannot: two tasks touching DIFFERENT modules that history
    // says move together.
    expect(pairs[0]?.modules).toEqual([]);
  });

  it("never combines shared and coupled into one score", () => {
    const { files, analysis, edges, taskA, taskB, taskC } = ownershipFixture();
    const pairs = conflicts(analysis, edges, files, [taskA, taskB, taskC]);
    for (const p of pairs) {
      expect(p).toHaveProperty("shared");
      expect(p).toHaveProperty("coupled");
      expect(Object.keys(p).sort()).toEqual(["a", "b", "coupled", "mode", "modules", "shared"]);
    }
  });

  /**
   * Mission criterion: "every answer from `own` or `conflicts` names which
   * mode produced it". `own` labels every row; a `conflicts` row printed
   * beside it with no label reads as the stronger claim, when in fact both
   * `shared` and `coupled` rest on `predictFiles`' guess about which files
   * each task will touch. The regression this guards is the absence of the
   * field entirely — the first version of `ConflictPair` had none.
   */
  it("labels every pair with the mode that produced it", () => {
    const { files, analysis, edges, taskA, taskB, taskC } = ownershipFixture();
    const pairs = conflicts(analysis, edges, files, [taskA, taskB, taskC]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(p.mode).toBe("predicted");
  });

  /**
   * The regression this guards: the spec's "summed nPMI over predicted
   * surfaces" alone. `weighEdges` never emits a self-pair and `rollUp` drops
   * self-loops, so two tasks predicting the SAME file have no edge between
   * them — under a summed-nPMI-only score this pair would tie with a totally
   * unrelated one at zero, hiding the clearest conflict there is. `shared`
   * is what makes it visible.
   */
  it("still flags two tasks predicting the same file even though no edge connects a file to itself", () => {
    const { files, analysis, taskA, taskB } = ownershipFixture();
    // No edges at all — the only signal available is the literal collision.
    const pairs = conflicts(analysis, [], files, [taskA, taskB]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.shared).toEqual(["src/auth/session.ts"]);
    expect(pairs[0]?.coupled).toBe(0);
  });

  /**
   * A manifest and its lockfile, tied for the top lexical score on BOTH
   * tasks (so both are in `shared`), suppressed through `classifyPair` —
   * the same noise floor `drift` applies to a real co-change edge, not a
   * hand-rolled "is this a manifest" predicate.
   */
  it("suppresses a manifest/lockfile pair every task predicts, producing no conflict on its own", () => {
    const files = ["package.json", "yarn.lock", "src/real/feature.ts"];
    const analysis = moduleAnalysis([
      { id: 0, name: "(repo root)", members: ["package.json", "yarn.lock"], layer: null },
      { id: 1, name: "src/real", members: ["src/real/feature.ts"], layer: null },
    ]);
    // A real coupling between the manifest and the lockfile, so a failure to
    // suppress it would show up as `coupled > 0`, not just as `shared`
    // wrongly non-empty.
    const edges = [edge(0, 1, 0.9)];

    const criteria = ["update the package.json and yarn.lock together"];
    const taskA = task({ id: "t-a", criteria });
    const taskB = task({ id: "t-b", criteria });

    expect(conflicts(analysis, edges, files, [taskA, taskB])).toEqual([]);
  });

  /**
   * The regression: suppression that only looked at the OTHER files already
   * in `shared`. A task criterion that names `package.json` and not the
   * lockfile — the ordinary way one is written — puts the manifest in
   * `shared` alone, where `classifyPair(f, f)` grades it `"candidate"`
   * (its mechanical branch needs a manifest AND a lock, and no path is
   * both). Two such tasks reported `shared: ["package.json"]`, i.e. exactly
   * the "a manifest every task touches produces no conflict on its own"
   * criterion failing, while the suite passed because its only manifest
   * fixture wrote criteria naming both halves of the pair.
   *
   * The lockfile that settles it is in the candidate corpus, which is where
   * `classifyPair` is now asked about it.
   */
  it("suppresses a manifest neither task's criteria pair with its lockfile", () => {
    const files = ["package.json", "pnpm-lock.yaml", "src/app/server.ts"];
    const analysis = moduleAnalysis([
      { id: 0, name: "(repo root)", members: ["package.json", "pnpm-lock.yaml"], layer: null },
      { id: 1, name: "src/app", members: ["src/app/server.ts"], layer: null },
    ]);
    // Names the manifest only — the lockfile is never mentioned, so it is
    // not in either task's predicted surface and cannot be paired against
    // from inside `shared`.
    const criteria = ["bump the express dependency in package json"];
    const taskA = task({ id: "t-a", criteria });
    const taskB = task({ id: "t-b", criteria });

    expect(conflicts(analysis, [], files, [taskA, taskB])).toEqual([]);
  });

  /**
   * The other half of the same suppression, and the half that shipped
   * missing: a manifest only ONE of the two tasks predicts.
   *
   * `shared` filtered its files through {@link isNoiseOnItsOwn} — the
   * corpus-wide question "does `classifyPair` call this file mechanical
   * against anything in this repository" — while `coupled` asked only the
   * pairwise `classifyPair(fa, fb)`, which grades `package.json` against
   * `src/app/server.ts` a perfectly good `"candidate"`. So the identical
   * `package.json`, with the identical lockfile sitting in the corpus, was
   * noise when both tasks named it and evidence of a real conflict when one
   * did: `coupled: 0.9` off a mechanical file the other half of this module
   * had already ruled out. `coupledScore`'s own comment asserted it skipped
   * "the same noise `shared` filters through"; it did not, and the function
   * it named by then no longer existed.
   *
   * One rule, both halves — a file that is not evidence on its own is not
   * evidence as one endpoint of a cross pair either.
   */
  it("suppresses a manifest as a coupled endpoint too, not only when both tasks predict it", () => {
    const files = ["package.json", "pnpm-lock.yaml", "src/app/server.ts"];
    const analysis = moduleAnalysis([
      { id: 0, name: "(repo root)", members: ["package.json", "pnpm-lock.yaml"], layer: null },
      { id: 1, name: "src/app", members: ["src/app/server.ts"], layer: null },
    ]);
    // package.json (0) <-> src/app/server.ts (2): strong history, but one
    // endpoint is a file this corpus's own lockfile says moves mechanically.
    const edges = [edge(0, 2, 0.9)];
    const manifestTask = task({ id: "t-a", criteria: ["bump the express dependency in package json"] });
    const appTask = task({ id: "t-b", criteria: ["the app server handles requests"] });

    const report = conflictReport(analysis, edges, files, [manifestTask, appTask]);
    expect(report.pairs).toEqual([]);
    // Both tasks WERE predicted for — this is a suppression, not an absence
    // of evidence, and the two must stay distinguishable.
    expect(report.covered).toEqual(["t-a", "t-b"]);
  });

  /**
   * The boundary of the rule above, pinned so nobody "fixes" it into a
   * name-shaped predicate: `classifyPair` calls a manifest mechanical only
   * when a lockfile that GOVERNS it exists. With no lockfile anywhere in the
   * corpus there is no evidence the coupling is mechanical, and two tasks
   * both predicting the file are reported — the same evidence-before-claim
   * rule the rest of this package is built on, rather than "the filename
   * looks like a manifest, therefore ignore it".
   */
  it("does not suppress a manifest the corpus holds no governing lockfile for", () => {
    const files = ["package.json", "src/app/server.ts"];
    const analysis = moduleAnalysis([
      { id: 0, name: "(repo root)", members: ["package.json"], layer: null },
      { id: 1, name: "src/app", members: ["src/app/server.ts"], layer: null },
    ]);
    const criteria = ["bump the express dependency in package json"];
    const pairs = conflicts(analysis, [], files, [
      task({ id: "t-a", criteria }),
      task({ id: "t-b", criteria }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.shared).toEqual(["package.json"]);
  });

  /**
   * `octograph.yaml`'s `lexicalConfidenceFloor` / `lexicalRunnerUpMargin`
   * reach `predictFiles` from here (see `config.ts`'s `lexicalOptions`). The
   * regression: `conflicts` called `predictFiles` with no options at all, so
   * both keys were parsed, documented as "settable per repo" — and inert.
   */
  it("honours the caller's lexical gate rather than always using the default", () => {
    const files = ["src/auth/session.ts", "src/token/store.ts"];
    const analysis = moduleAnalysis([
      { id: 0, name: "src/auth", members: ["src/auth/session.ts"], layer: null },
      { id: 1, name: "src/token", members: ["src/token/store.ts"], layer: null },
    ]);
    // `session.ts` recovers 2 of the query's 3 scoring tokens (auth, session;
    // `token` belongs to the other file, `validated` to neither) — a score of
    // 2/3, comfortably over the default floor and under a 0.7 one.
    const criteria = ["the auth session token is validated"];
    const taskA = task({ id: "t-a", criteria });
    const taskB = task({ id: "t-b", criteria });

    const byDefault = conflicts(analysis, [], files, [taskA, taskB]);
    expect(byDefault[0]?.shared).toEqual(["src/auth/session.ts"]);

    const strict = conflicts(analysis, [], files, [taskA, taskB], { confidenceFloor: 0.7 });
    expect(strict).toEqual([]);
  });

  /**
   * The fixture matters as much as the assertion here. This test's first
   * version used a `src/moduleA/x.ts` / `src/moduleB/y.ts` corpus whose every
   * shared token (`src`, `module`, `ts`) has `df === n`, so every idf is
   * `ln(1) === 0` and `predictFiles` answered NOTHING for either task — the
   * empty result it asserted came from a predictor with no signal, not from a
   * clean decomposition, and the test would have passed just as well against
   * a `conflicts` that reported nothing ever. It is built on `ownershipFixture`
   * now, where both tasks demonstrably predict a file (see `covered`), those
   * files differ, and no edge couples them: clean because it was looked at.
   */
  it("reports nothing for a clean decomposition it did predict surfaces for", () => {
    const { files, analysis, taskA, taskC } = ownershipFixture();
    const report = conflictReport(analysis, [], files, [taskA, taskC]);

    expect(report.pairs).toEqual([]);
    expect(report.covered).toEqual(["t-a", "t-c"]);
    expect(report.uncovered).toEqual([]);
  });

  it("finds the same conflict regardless of whether the two tasks share a mission or a campaign", () => {
    const { files, analysis, edges, taskA, taskB } = ownershipFixture();
    const crossMission: BoardTask = { ...taskA, mission: "m1", campaign: "c1" };
    const otherMission: BoardTask = { ...taskB, mission: "m2", campaign: "c2" };

    const pairs = conflicts(analysis, edges, files, [crossMission, otherMission]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.shared).toEqual(["src/auth/session.ts"]);
  });

  it("ignores a synthetic bridge edge (support 0) when scoring coupled", () => {
    const { files, analysis, taskA, taskC } = ownershipFixture();
    const bridge: Edge = { a: 0, b: 1, support: 0, npmi: 0.99, confidence: 0 };
    expect(conflicts(analysis, [bridge], files, [taskA, taskC])).toEqual([]);
  });

  it("never lets a negatively-correlated pair contribute to coupled", () => {
    const { files, analysis, taskA, taskC } = ownershipFixture();
    const negative = edge(0, 1, -0.9);
    expect(conflicts(analysis, [negative], files, [taskA, taskC])).toEqual([]);
  });

  it("orders pairs deterministically by (shared.length, coupled, a, b) regardless of task input order", () => {
    const { files, analysis, edges, taskA, taskB, taskC } = ownershipFixture();
    const forward = conflicts(analysis, edges, files, [taskA, taskB, taskC]);
    const shuffled = conflicts(analysis, edges, files, [taskC, taskB, taskA]);
    expect(shuffled).toEqual(forward);
  });

  it("contributes nothing, rather than throwing, for a task whose criteria have no confident match", () => {
    const { files, analysis, taskA } = ownershipFixture();
    const boilerplate = task({ id: "t-boilerplate", criteria: ["the code is well tested"] });
    expect(conflicts(analysis, [], files, [taskA, boilerplate])).toEqual([]);
  });

  /**
   * **The claim this command makes when it reports nothing.**
   *
   * `predictFiles` answers for a minority of real tasks — the calibration in
   * `lexical.ts` measured 3 of 8 on this repo's own labelled dataset, and
   * `conflicts` on this repo's M4 mission produced a surface for 1 task of 6.
   * A task with no surface takes part in no pair, so a mission whose tasks
   * the predictor had nothing to say about returns exactly what a genuinely
   * clean decomposition returns: an empty list.
   *
   * Those two are not the same answer and must never render as one. "Nothing
   * predicted, therefore no conflict" is this campaign's recurring defect in
   * its purest form — a verdict outrunning what was computed, in a command
   * whose entire product is that verdict. So the report carries which tasks
   * it actually covers alongside the pairs, and neither is derivable from the
   * other.
   */
  it("distinguishes a clean decomposition from one nothing was predicted for", () => {
    const { files, analysis } = ownershipFixture();
    const boilerplateA = task({ id: "t-a", criteria: ["the code is well tested"] });
    const boilerplateB = task({ id: "t-b", criteria: ["the change is reviewed"] });

    const nothingPredicted = conflictReport(analysis, [], files, [boilerplateA, boilerplateB]);
    expect(nothingPredicted.pairs).toEqual([]);
    expect(nothingPredicted.covered).toEqual([]);
    expect(nothingPredicted.uncovered).toEqual(["t-a", "t-b"]);

    // A genuinely clean decomposition: both tasks predicted a surface, the
    // surfaces do not collide, and nothing couples them. Identical `pairs`,
    // opposite meaning — which is the whole point of carrying coverage.
    const { taskA, taskC } = ownershipFixture();
    const clean = conflictReport(analysis, [], files, [taskA, taskC]);
    expect(clean.pairs).toEqual(nothingPredicted.pairs);
    expect(clean.covered).toEqual(["t-a", "t-c"]);
    expect(clean.uncovered).toEqual([]);
  });

  /** Partial coverage is the ordinary case, not an edge case: a reported pair
   *  and an unanswered task in the same report, each named, so a reader can
   *  see the answer is about two of three tasks rather than all of them. */
  it("names the uncovered tasks alongside the pairs it did find", () => {
    const { files, analysis, edges, taskA, taskB } = ownershipFixture();
    const boilerplate = task({ id: "t-z", criteria: ["the code is well tested"] });

    const report = conflictReport(analysis, edges, files, [taskA, taskB, boilerplate]);
    expect(report.pairs).toHaveLength(1);
    expect(report.covered).toEqual(["t-a", "t-b"]);
    expect(report.uncovered).toEqual(["t-z"]);
  });

  /** Deterministic like everything else here: both lists are `compare`-sorted
   *  rather than left in whatever order `tasks` arrived in. */
  it("sorts covered and uncovered through compare, not by input order", () => {
    const { files, analysis } = ownershipFixture();
    const forward = conflictReport(analysis, [], files, [
      task({ id: "t-b", criteria: ["the auth session token is validated"] }),
      task({ id: "t-a", criteria: ["the auth session token is validated"] }),
      task({ id: "t-z", criteria: ["the code is well tested"] }),
      task({ id: "t-c", criteria: ["the change is reviewed"] }),
    ]);
    expect(forward.covered).toEqual(["t-a", "t-b"]);
    expect(forward.uncovered).toEqual(["t-c", "t-z"]);
  });
});
