import { describe, expect, it } from "vitest";
import type { Analysis } from "../src/analyze.js";
import type { BoardTask } from "../src/board.js";
import { conflicts } from "../src/conflicts.js";
import type { Edge } from "../src/weights.js";

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
      expect(Object.keys(p).sort()).toEqual(["a", "b", "coupled", "modules", "shared"]);
    }
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

  it("reports nothing for a clean decomposition with no shared file and no coupling", () => {
    const files = ["src/moduleA/x.ts", "src/moduleB/y.ts"];
    const analysis = moduleAnalysis([
      { id: 0, name: "src/moduleA", members: ["src/moduleA/x.ts"], layer: null },
      { id: 1, name: "src/moduleB", members: ["src/moduleB/y.ts"], layer: null },
    ]);
    const taskA = task({ id: "t-a", criteria: ["the moduleA x behaviour is correct"] });
    const taskB = task({ id: "t-b", criteria: ["the moduleB y behaviour is correct"] });

    expect(conflicts(analysis, [], files, [taskA, taskB])).toEqual([]);
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
});
