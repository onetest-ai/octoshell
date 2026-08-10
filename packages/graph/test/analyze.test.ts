import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { analyze } from "../src/analyze.js";
import { renderMap } from "../src/render.js";
import { DEFAULTS } from "../src/config.js";

const NOW = Date.UTC(2026, 0, 30);

/** Every path the analysis placed inside some module. */
function placed(modules: { members: string[] }[]): Set<string> {
  return new Set(modules.flatMap((m) => m.members));
}

/**
 * Background churn that touches none of the files under test.
 *
 * It is load-bearing rather than decorative: a file present in *literally*
 * every commit has marginal probability 1, which drives its nPMI to exactly 0
 * and its weighted degree with it, so `detectHubs` never flags it (see
 * e2e.test.ts). Diluting the marginal is what makes hub quarantine fire at all.
 * Each pair is committed twice so it clears the default `minSupport` of 2.
 */
function backgroundChurn(pairs: number): CommitSpec[] {
  const out: CommitSpec[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`] });
    out.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`] });
  }
  return out;
}

describe("analyze: hub reattachment", () => {
  it("places a hub whose neighbours all cluster, into the community that voted for it", () => {
    const commits: CommitSpec[] = [];
    // Two dense regions plus a file that rides along with both — the classic
    // hub, and one whose neighbours do have communities of their own.
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1/a.ts", "r1/b.ts", "r1/c.ts", "cfg.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2/a.ts", "r2/b.ts", "r2/c.ts", "cfg.ts"] });
    commits.push(...backgroundChurn(15));

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    expect(analysis.hubs).toContain("cfg.ts");
    expect(placed(analysis.modules).has("cfg.ts")).toBe(true);
  });

  /**
   * The regression this file exists for.
   *
   * A hub is reattached by plurality vote, but only a neighbour that HAS a
   * community can vote — and a neighbour only has one if it kept an edge that
   * touches no hub. In a star (one file committed pairwise with each leaf and
   * nothing else) every leaf's sole edge runs to the hub, so no leaf is in the
   * partition, no vote is cast, and the pre-fix code left `best === -1` and
   * dropped the hub on the floor: quarantined out of clustering, absent from
   * every community, present in the artifact only as a name under `hubs`.
   *
   * That is not a hypothetical shape — it is a config file, a schema, or a
   * generated manifest committed with each consumer in turn.
   */
  it("still places a hub that no community voted for, using its declared module", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 20; i++) {
      commits.push({ files: ["tools/cfg.ts", `leaf/${i}.ts`] });
      commits.push({ files: ["tools/cfg.ts", `leaf/${i}.ts`] });
    }
    commits.push(...backgroundChurn(15));

    const { analysis, spine } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });

    // Precondition: the star centre really is quarantined, and really does get
    // no vote (no leaf of the star reaches a community).
    expect(analysis.hubs).toEqual(["tools/cfg.ts"]);

    expect(placed(analysis.modules).has("tools/cfg.ts")).toBe(true);
    // And it lands in the module the declared spine names for its path, not in
    // whatever cluster happened to be biggest — co-change had no opinion here,
    // so the map must not invent one.
    const home = analysis.modules.find((m) => m.members.includes("tools/cfg.ts"));
    expect(home?.name).toBe(spine.moduleOf("tools/cfg.ts"));
  });

  /**
   * The regression this block exists for (M2 completion-gate defect 2).
   *
   * `cfg.ts` here is a hub that DOES get a vote — unlike the star-centre case
   * above — so the "unvoted" fallback never fires for it. But `cfg.ts`'s own
   * declared module is "(repo root)" (root-level, two-segment fallback), no
   * other file shares that name, and the vote sends it into whichever of
   * r1/r2 it touches more. Pre-fix, "(repo root)" never became a key in the
   * merged map at all — not missing a member, missing ENTIRELY — while
   * `rollUp` still emitted a moduleEdges row naming it (over the full,
   * hub-inclusive edge set, oblivious to which community won the vote). A
   * reader of map.md would see the strongest edge in the graph point at a
   * module with no heading.
   */
  it("keeps a hub's own declared module as a heading even when the naming vote sends its files elsewhere", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1/a.ts", "r1/b.ts", "r1/c.ts", "cfg.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2/a.ts", "r2/b.ts", "r2/c.ts", "cfg.ts"] });
    commits.push(...backgroundChurn(15));

    const { analysis, spine } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });

    // Preconditions: cfg.ts really is a hub, and it really does declare
    // "(repo root)".
    expect(analysis.hubs).toContain("cfg.ts");
    expect(spine.moduleOf("cfg.ts")).toBe("(repo root)");

    // Precondition: "(repo root)" really is the strongest thing moduleEdges
    // names here — without this the fix could be satisfied by an
    // implementation that just drops the edge instead of adding the heading.
    const dotEdges = analysis.moduleEdges.filter(
      (e) => e.from === "(repo root)" || e.to === "(repo root)",
    );
    expect(dotEdges.length).toBeGreaterThan(0);

    const names = analysis.modules.map((m) => m.name);
    expect(names).toContain("(repo root)");
    const dot = analysis.modules.find((m) => m.name === "(repo root)");
    expect(dot?.members).toContain("cfg.ts");
  });
});

describe("analyze: module identity invariant", () => {
  /**
   * `moduleEdges` (rollUp/readGraphify, keyed by `spine.moduleOf` alone over
   * the full edge set) and `modules[]` (Louvain communities, named by their
   * central member and reconciled against the declared spine — see the hub-
   * reattachment block above) are two independent computations of "what is a
   * module". Nothing in the suite cross-checked that they agree until this
   * test: every module a dependency line names must have a heading of its own,
   * or map.md renders a dangling reference — the exact defect class M1 already
   * hit once for edge weights (see conventions.test.ts).
   */
  function expectNoDanglingModuleEdges(analysis: {
    modules: { name: string }[];
    moduleEdges: { from: string; to: string }[];
  }): void {
    const names = new Set(analysis.modules.map((m) => m.name));
    for (const e of analysis.moduleEdges) {
      expect(names.has(e.from)).toBe(true);
      expect(names.has(e.to)).toBe(true);
    }
  }

  it("holds when a naming vote sends a hub's declared module away from its own heading", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1/a.ts", "r1/b.ts", "r1/c.ts", "cfg.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2/a.ts", "r2/b.ts", "r2/c.ts", "cfg.ts"] });
    commits.push(...backgroundChurn(15));
    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    expectNoDanglingModuleEdges(analysis);
  });

  /**
   * The same invariant on the OTHER branch of `moduleEdges`, which the two
   * tests around it cannot reach: they exercise `rollUp`, whose endpoints are
   * `moduleOf` over harvested files and so are backed by a file by
   * construction. `readGraphify`'s are not. Graphify indexes the whole tree
   * while `harvest` only sees commits inside the `--since` window, under the
   * mega-commit cap, touching two or more paths — so a package with no
   * analysable churn in that window is an ordinary import endpoint with no
   * harvested file at all.
   *
   * Pre-fix, `pkg/c` was named by a dependency line in map.md and had no
   * heading of its own, and `layerRanks` dropped every edge touching it.
   */
  it("holds when Graphify names a module the harvest window never touched", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/a/a1.ts", "pkg/a/a2.ts"] });
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/b/b1.ts", "pkg/b/b2.ts"] });
    const root = buildRepo(commits);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'pkg/*'\n");
    for (const p of ["a", "b", "c"]) {
      mkdirSync(join(root, `pkg/${p}`), { recursive: true });
      writeFileSync(join(root, `pkg/${p}/package.json`), `{"name":"${p}"}\n`);
    }
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    writeFileSync(
      join(root, "graphify-out/graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", file: "pkg/a/a1.ts" },
          { id: "b", file: "pkg/b/b1.ts" },
          // Declared, imported — and never touched by an analysable commit.
          { id: "c", file: "pkg/c/c1.ts" },
        ],
        edges: [
          { source: "a", target: "b", type: "imports" },
          { source: "b", target: "c", type: "imports" },
        ],
      }),
    );

    const { analysis, files } = analyze(root, DEFAULTS, { now: NOW });

    // Preconditions: the Graphify tier really is in play, `pkg/c` really is
    // unharvested, and a module edge really does name it — without all three
    // the assertion below passes for any implementation.
    expect(analysis.spineSource).toBe("graphify");
    expect(files.some((f) => f.startsWith("pkg/c/"))).toBe(false);
    expect(analysis.moduleEdges).toContainEqual({ from: "pkg/b", to: "pkg/c", weight: 1 });

    expectNoDanglingModuleEdges(analysis);

    // Present as a real heading, and honest about what the history says: the
    // module exists and is depended upon, no analysable commit touched it.
    const c = analysis.modules.find((m) => m.name === "pkg/c");
    expect(c?.members).toEqual([]);
    expect(renderMap(analysis, DEFAULTS.budgetTokens)).toContain("**pkg/c**");

    // And it is ranked rather than skipped — `layerRanks` dropped every edge
    // touching an unknown module, so pre-fix `pkg/b` came out as a leaf.
    expect(analysis.modules.find((m) => m.name === "pkg/a")?.layer).toBe(0);
    expect(analysis.modules.find((m) => m.name === "pkg/b")?.layer).toBe(1);
    expect(c?.layer).toBe(2);
  });

  it("holds for an unvoted star-centre hub", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 20; i++) {
      commits.push({ files: ["tools/cfg.ts", `leaf/${i}.ts`] });
      commits.push({ files: ["tools/cfg.ts", `leaf/${i}.ts`] });
    }
    commits.push(...backgroundChurn(15));
    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    expectNoDanglingModuleEdges(analysis);
  });
});

describe("analyze: determinism", () => {
  /**
   * Module rows are ordered by size, then by name. The name comparison must be
   * the package's `compare` (UTF-16 code units), never `localeCompare`:
   *
   *  - `localeCompare` collates by the machine's default locale, so the
   *    committed artifact would reorder on nothing but a change of LANG
   *    ("pkg/aa" sorts before "pkg/z" in en-US and after it in da-DK).
   *  - It disagrees with code-unit order on this very machine wherever case is
   *    involved — it puts "alpha" before "Zed", code units put "Zed" first — so
   *    the module list would contradict the `Spine.modules`, `rollUp` and
   *    `readGraphify` lists rendered beside it.
   *
   * Two equal-sized regions in capitalised and lowercase directories put those
   * two rules on opposite sides of the tie-break.
   */
  it("orders equal-sized modules by code unit, not by locale collation", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["Zed/a.ts", "Zed/b.ts", "Zed/c.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["alpha/a.ts", "alpha/b.ts", "alpha/c.ts"] });

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    const names = analysis.modules.map((m) => m.name);
    expect(names).toContain("Zed");
    expect(names).toContain("alpha");
    // Equal member counts, so the tie-break alone decides. localeCompare would
    // emit ["alpha", "Zed"].
    expect(names.indexOf("Zed")).toBeLessThan(names.indexOf("alpha"));
  });

  it("two runs over one repo produce identical analyses", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1/a.ts", "r1/b.ts", "r1/c.ts", "cfg.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2/a.ts", "r2/b.ts", "r2/c.ts", "cfg.ts"] });
    commits.push(...backgroundChurn(15));

    const repo = buildRepo(commits);
    const first = analyze(repo, DEFAULTS, { now: NOW });
    const second = analyze(repo, DEFAULTS, { now: NOW });
    expect(JSON.stringify(second.analysis)).toBe(JSON.stringify(first.analysis));
  });
});

describe("analyze: no fabricated fields", () => {
  /**
   * The regression this test exists for (M3 bug).
   *
   * `clusterIds` was `{ kept: 0, fresh: modules.length }` — `kept` was ALWAYS
   * 0, produced by no computation at all. `remapClusters` (stability.ts) is
   * the real stability remap and is never called from `analyze()`; wiring it
   * in belongs to Task 15, once a previously-committed artifact exists to
   * diff against. Until then, no field should stand in for a number nobody
   * computed — `analyze()`'s return must not carry `clusterIds` at all.
   */
  it("does not carry a clusterIds field nobody computed", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/a/a1.ts", "pkg/a/a2.ts"] });
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/b/b1.ts", "pkg/b/b2.ts"] });

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    expect("clusterIds" in analysis).toBe(false);
  });
});
