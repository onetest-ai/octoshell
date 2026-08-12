import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCommits, buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { analyze, type ModuleSummary } from "../src/analyze.js";
import { renderMap } from "../src/render.js";
import { DEFAULTS } from "../src/config.js";
import { readArtifact, writeArtifact } from "../src/artifact.js";
import { doctor } from "../src/doctor.js";

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

/** `StoredGraph.clusters`' shape, keyed by each module's own id. */
function clustersOf(modules: ModuleSummary[]): Record<number, string[]> {
  const clusters: Record<number, string[]> = {};
  for (const m of modules) clusters[m.id] = m.members;
  return clusters;
}

/** The inverse of the `Record` `readArtifact` hands back: `remapClusters`'s own `Map` shape. */
function toClusterMap(clusters: Record<number, string[]>): Map<number, string[]> {
  return new Map(Object.entries(clusters).map(([k, v]) => [Number(k), v]));
}

describe("analyze: cluster id stability, wired to the Jaccard remap", () => {
  /**
   * The regression this block replaces (M3 bug, see git history for
   * a6b790d9).
   *
   * `clusterIds` used to be `{ kept: 0, fresh: modules.length }` — `kept` was
   * ALWAYS 0, produced by no computation at all — so it was deleted rather
   * than shipped as a placeholder. `remapClusters` (stability.ts) is the real
   * stability remap; this block proves `analyze()` actually calls it, using
   * the previous run's clusters as they really arrive: round-tripped through
   * `writeArtifact`/`readArtifact` (see artifact.ts / T3.3), never an
   * in-memory value the current run just happened to hold.
   *
   * A single-run check cannot catch a hardcoded constant back — a constant
   * satisfies it trivially — so every test below drives analyze() at least
   * twice: once to establish the "previous" run, once (or twice) more to
   * observe what changes and what does not.
   */
  it("an unchanged rerun keeps every id (kept > 0) while an altered-history rerun mints a fresh one for the new module", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/a/a1.ts", "pkg/a/a2.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/b/b1.ts", "pkg/b/b2.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/c/c1.ts", "pkg/c/c2.ts"] });
    const root = buildRepo(commits);

    const first = analyze(root, DEFAULTS, { now: NOW });
    expect(first.analysis.modules).toHaveLength(3);

    // The previous run's clusters, as a real caller would actually have them:
    // written to disk, then read back — not the in-memory `first.analysis`.
    // A separate directory, not `resolveOut(root, ...)`: writing the
    // artifact INTO the repo would sit untracked until the next commit, and
    // `appendCommits` below stages with `git add -A` — it would silently
    // become a tracked file (and a spurious extra module) the moment history
    // moves on. Real callers resolve a path with `resolveOut`; that path
    // resolution is T3.3's own contract (artifact.test.ts), not this task's.
    const dir = mkdtempClean("octograph-artifact-");
    writeArtifact(dir, { version: 1, clusters: clustersOf(first.analysis.modules), config: DEFAULTS });
    const stored = readArtifact(dir);
    if (stored === null) throw new Error("expected writeArtifact's own file to read back");
    const previousClusters = toClusterMap(stored.clusters);

    // Unchanged rerun: every module's declared membership is identical to the
    // previous run's, so every one of them should match its own old id
    // (jaccard 1.0) — `kept` must be the module count, not 0.
    const same = analyze(root, DEFAULTS, { now: NOW, previousClusters });
    expect(same.analysis.clusterIds).toEqual({ kept: 3, fresh: 0 });

    // Altered-history rerun: append commits for a brand new module that
    // shares no path at all with any previous cluster. The three original
    // modules are untouched and still match their old ids; the new one can
    // only mint a fresh id, since nothing in `previousClusters` overlaps it.
    appendCommits(
      root,
      Array.from({ length: 8 }, () => ({ files: ["pkg/d/d1.ts", "pkg/d/d2.ts"] })),
    );
    const altered = analyze(root, DEFAULTS, { now: NOW, previousClusters });
    expect(altered.analysis.modules).toHaveLength(4);
    expect(altered.analysis.clusterIds).toEqual({ kept: 3, fresh: 1 });

    // The pair a hardcoded constant could still slip past individually (e.g.
    // `fresh` tracking `modules.length` while `kept` stays a fixed 0) is
    // exactly the pair this asserts differs as a whole.
    expect(altered.analysis.clusterIds).not.toEqual(same.analysis.clusterIds);
  });

  it("an untouched module keeps its previous id even when growing another module reorders the array", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/a/a1.ts", "pkg/a/a2.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/z/z1.ts", "pkg/z/z2.ts"] });
    const root = buildRepo(commits);

    const first = analyze(root, DEFAULTS, { now: NOW });
    const a = first.analysis.modules.find((m) => m.name === "pkg/a");
    const z = first.analysis.modules.find((m) => m.name === "pkg/z");
    if (a === undefined || z === undefined) throw new Error("expected both pkg/a and pkg/z");
    // Precondition: equal member counts, so the name tie-break put pkg/a
    // first — without this the reorder below proves nothing.
    expect(a.id).toBe(0);
    expect(z.id).toBe(1);

    // A separate directory, not `resolveOut(root, ...)`: writing the
    // artifact INTO the repo would sit untracked until the next commit, and
    // `appendCommits` below stages with `git add -A` — it would silently
    // become a tracked file (and a spurious extra module) the moment history
    // moves on. Real callers resolve a path with `resolveOut`; that path
    // resolution is T3.3's own contract (artifact.test.ts), not this task's.
    const dir = mkdtempClean("octograph-artifact-");
    writeArtifact(dir, { version: 1, clusters: clustersOf(first.analysis.modules), config: DEFAULTS });
    const stored = readArtifact(dir);
    if (stored === null) throw new Error("expected writeArtifact's own file to read back");
    const previousClusters = toClusterMap(stored.clusters);

    // Touch pkg/z ONLY: give it ten more declared members, nothing under
    // pkg/a. Each new pair is committed twice — the sort tie-break above
    // reads community size, and a pair below `minSupport` (2) never earns an
    // edge, so it would never join a community or move the sort at all (see
    // the sort's own comment in analyze.ts). With real support, pkg/z's
    // community — and so its position — genuinely outsizes pkg/a's, the exact
    // reordering that, without the remap, would relabel pkg/a too.
    const growth: CommitSpec[] = [];
    for (let i = 0; i < 5; i++) {
      const pair = [`pkg/z/extra${2 * i}.ts`, `pkg/z/extra${2 * i + 1}.ts`];
      growth.push({ files: pair }, { files: pair });
    }
    appendCommits(root, growth);
    const second = analyze(root, DEFAULTS, { now: NOW, previousClusters });

    // Precondition: the reorder genuinely happened.
    expect(second.analysis.modules[0]?.name).toBe("pkg/z");

    const a2 = second.analysis.modules.find((m) => m.name === "pkg/a");
    const z2 = second.analysis.modules.find((m) => m.name === "pkg/z");
    if (a2 === undefined || z2 === undefined) throw new Error("expected both pkg/a and pkg/z");

    // The untouched module keeps the id it had in the previously written
    // clusters.json, despite no longer sitting at array position 0.
    expect(a2.id).toBe(0);
    // The touched module's membership overlap with its old self dropped well
    // under the 0.5 threshold (2 of 12 members), so it is free to change —
    // and does, minting the next id above the old max.
    expect(z2.id).toBe(2);
    expect(z2.id).not.toBe(a2.id);
  });

  it("wires the greedy tie-break: two equally-good new clusters never both claim one old id", () => {
    // A previous run's single cluster (fabricated id 9) whose members are
    // split evenly across two NEW declared modules this run — jaccard 0.5
    // against each, an exact tie at the threshold.
    const previousClusters = new Map<number, string[]>([
      [9, ["pkg/p/a.ts", "pkg/p/b.ts", "pkg/q/a.ts", "pkg/q/b.ts"]],
    ]);

    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/p/a.ts", "pkg/p/b.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["pkg/q/a.ts", "pkg/q/b.ts"] });
    const root = buildRepo(commits);

    const { analysis } = analyze(root, DEFAULTS, { now: NOW, previousClusters });
    const p = analysis.modules.find((m) => m.name === "pkg/p");
    const q = analysis.modules.find((m) => m.name === "pkg/q");
    if (p === undefined || q === undefined) throw new Error("expected both pkg/p and pkg/q");

    // Lower positional id wins a contested tie (see stability.test.ts's own
    // "gives a contested old id to the strongest overlap" test for the same
    // rule at the unit level) — pkg/p sorts first alphabetically.
    expect(p.id).toBe(9);
    // The loser is never left unclaimed against the SAME old id — it mints
    // a fresh one instead, strictly above the old maximum.
    expect(q.id).toBe(10);
    expect(q.id).not.toBe(p.id);
    expect(analysis.clusterIds).toEqual({ kept: 1, fresh: 1 });
  });

  /**
   * The regression this test exists for (found reviewing this task).
   *
   * `analyze()` emits real modules with NO members: a module Graphify declares
   * — a genuine `moduleEdges` endpoint that gets its own heading — whose files
   * no analysable commit touched inside the harvest window (see "holds when
   * Graphify names a module the harvest window never touched" above, and
   * `spine.modules`). Fed to the remap, such a cluster scored 0 against its own
   * previous self, because raw Jaccard answers "no shared union" for two empty
   * sets. So it fell under the threshold and minted a FRESH id on every run:
   * pkg/c came back 2, then 3, then 4, … on three consecutive runs of a repo
   * whose history never moved — the committed-artifact churn A5b exists to
   * prevent, straight through the mitigation for it. The same miscount also
   * made `clusterIds` claim `{ kept: 2, fresh: 1 }` for a rerun with nothing
   * fresh in it.
   *
   * Three runs, not two: a two-run check would also pass an implementation
   * that merely offset the id once.
   */
  it("a declared module the harvest window never touched keeps its id across reruns", () => {
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

    const dir = mkdtempClean("octograph-artifact-");
    /** One run, through the artifact a real caller would have committed. */
    const run = (previous: Map<number, string[]> | undefined) => {
      const { analysis } = analyze(root, DEFAULTS, { now: NOW, previousClusters: previous });
      writeArtifact(dir, { version: 1, clusters: clustersOf(analysis.modules), config: DEFAULTS });
      const stored = readArtifact(dir);
      if (stored === null) throw new Error("expected writeArtifact's own file to read back");
      return { analysis, clusters: toClusterMap(stored.clusters) };
    };

    const first = run(undefined);
    // Preconditions: the Graphify tier really is in play and pkg/c really is
    // the memberless module — without both, the reruns below prove nothing.
    expect(first.analysis.spineSource).toBe("graphify");
    const c1 = first.analysis.modules.find((m) => m.name === "pkg/c");
    expect(c1?.members).toEqual([]);

    // Nothing whatsoever changes between runs — no commit is appended, the
    // same `now` is passed — so every id must survive both reruns, the
    // memberless one included, and no run may report a fresh cluster.
    const second = run(first.clusters);
    const third = run(second.clusters);

    const idsOf = (a: typeof first.analysis) =>
      Object.fromEntries(a.modules.map((m) => [m.name, m.id]));
    expect(idsOf(second.analysis)).toEqual(idsOf(first.analysis));
    expect(idsOf(third.analysis)).toEqual(idsOf(first.analysis));
    expect(second.analysis.clusterIds).toEqual({ kept: 3, fresh: 0 });
    expect(third.analysis.clusterIds).toEqual({ kept: 3, fresh: 0 });
  });

  it("first run with no previous clusters mints every id fresh, exactly as before this option existed", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/a/a1.ts", "pkg/a/a2.ts"] });
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/b/b1.ts", "pkg/b/b2.ts"] });

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    expect(analysis.clusterIds).toEqual({ kept: 0, fresh: 2 });
    expect(analysis.modules.map((m) => m.id).sort((x, y) => x - y)).toEqual([0, 1]);
  });
});

describe("analyze: members come from the declared spine, not the naming community", () => {
  /**
   * The regression this test exists for (M2 bug: "members lists a Louvain
   * community's files under a declared module's heading").
   *
   * `pkg/A/leak.ts` is declared under `pkg/A`, but co-changes heavily with
   * `pkg/B`'s files and barely at all with `pkg/A`'s own — so Louvain groups
   * it into the community that resolves to the "pkg/B" heading. Pre-fix,
   * `members` came straight from that community's accumulated id list, so
   * `leak.ts` was listed under **pkg/B** (a module it is not declared in) and
   * silently absent from **pkg/A** (the module that actually declares it) —
   * measured on this repo, the same defect put 3 of `packages/tokenomics`'s
   * 4 listed files under a heading none of them are declared in.
   *
   * Spec A5c: "Module identity comes from the declared spine when present."
   * A heading naming a declared module must list that module's declared
   * files — `filesByModule(table.files, spine.moduleOf)` — regardless of
   * which community happened to win the vote for that name. Communities
   * decide GROUPING and NAMING where no declared boundary exists; they do
   * not decide what a declared module contains.
   */
  it("keeps a file under its declared module's row even when co-change groups it elsewhere", () => {
    const commits: CommitSpec[] = [];
    // pkg/A's own internal churn — dense enough to form its own community.
    for (let i = 0; i < 10; i++) commits.push({ files: ["pkg/A/a1.ts", "pkg/A/a2.ts"] });
    // pkg/B's own internal churn — stronger than leak's ties to it, so a
    // real pkg/B file (not leak.ts) wins the naming vote for the community.
    for (let i = 0; i < 10; i++) commits.push({ files: ["pkg/B/b1.ts", "pkg/B/b2.ts"] });
    // leak.ts is declared under pkg/A but never once co-changes with pkg/A's
    // own files — only with pkg/B's, which is what pulls it into pkg/B's
    // Louvain community.
    for (let i = 0; i < 4; i++) {
      commits.push({ files: ["pkg/A/leak.ts", "pkg/B/b1.ts", "pkg/B/b2.ts"] });
    }

    const root = buildRepo(commits);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'pkg/*'\n");
    for (const p of ["A", "B"]) {
      mkdirSync(join(root, `pkg/${p}`), { recursive: true });
      writeFileSync(join(root, `pkg/${p}/package.json`), `{"name":"${p}"}\n`);
    }

    const { analysis, spine } = analyze(root, DEFAULTS, { now: NOW });

    // Preconditions: the declared boundary really does put leak.ts under
    // pkg/A, and co-change really did cluster it away from pkg/A's own
    // files — without both, the assertions below hold for any
    // implementation, fixed or not.
    expect(spine.moduleOf("pkg/A/leak.ts")).toBe("pkg/A");
    const a = analysis.modules.find((m) => m.name === "pkg/A");
    const b = analysis.modules.find((m) => m.name === "pkg/B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // The declared module lists its own file...
    expect(a?.members).toContain("pkg/A/leak.ts");
    // ...and the module that merely won the naming vote for leak's community
    // does not inherit it just because co-change grouped it there.
    expect(b?.members).not.toContain("pkg/A/leak.ts");
  });
});

/**
 * Spec A8: test files are tagged, never dropped. They stay queryable and
 * stay in `ModuleSummary.members` — the "which tests cover this module"
 * answer — but must be invisible to the clustering step (community
 * detection), because a test co-changes with its own subject constantly and
 * two different modules' test suites tend to co-change with EACH OTHER too
 * (a shared CI fixture, a repo-wide test refactor), which is exactly the
 * kind of bridge that would merge two unrelated modules into one community
 * for a reason that has nothing to do with architecture.
 *
 * Before this fix, nothing in this suite named that invariant: `members` came
 * entirely from `filesByModule` (declared identity, see the fix above this
 * block) and was never sourced from the Louvain partition, so a test asserting
 * only membership passes whether or not clustering excludes tests. The
 * invariant this block pins is therefore about CLUSTERING, not membership —
 * membership is asserted too, but only as A8's other, already-covered half.
 */
describe("analyze: A8 — test files are excluded from clustering, not from membership", () => {
  it("keeps test files as declared members while stopping a test-to-test bridge from linking two modules", () => {
    const commits: CommitSpec[] = [];
    // modA and modB each co-change internally with their own test file —
    // ordinary, expected coupling.
    for (let i = 0; i < 20; i++) {
      commits.push({ files: ["modA/subject.ts", "modA/subject.test.ts"] });
    }
    for (let i = 0; i < 20; i++) {
      commits.push({ files: ["modB/subject.ts", "modB/subject.test.ts"] });
    }
    // The two modules' SUBJECT files never co-change directly. Their TEST
    // files do, heavily — a test-shaped community that would otherwise bridge
    // modA and modB together for a reason with no architectural meaning.
    for (let i = 0; i < 20; i++) {
      commits.push({ files: ["modA/subject.test.ts", "modB/subject.test.ts"] });
    }
    // 15 disjoint background pairs so the graph has real components besides
    // the modA/modB cluster — bridging is otherwise a no-op with only one
    // cluster in play, and the count below would not distinguish anything.
    commits.push(...backgroundChurn(15));

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });

    // (a) A8's membership half: tests stay in `members`, under their own
    // module — the "which tests cover this module" answer.
    const a = analysis.modules.find((m) => m.name === "modA");
    const b = analysis.modules.find((m) => m.name === "modB");
    expect(a?.members).toEqual(["modA/subject.test.ts", "modA/subject.ts"]);
    expect(b?.members).toEqual(["modB/subject.test.ts", "modB/subject.ts"]);

    // (b) A8's clustering half. With tests excluded, no edge touching
    // modA/modB's four files survives into `clusterable` at all (every one of
    // them touches a test id): the pair has nothing left to bridge, and only
    // the 15 background components need connecting — 14 bridges for a
    // spanning tree over them. Restore the test-to-test edge to clustering
    // (delete the exclusion) and the modA/modB files form ONE additional
    // component that also needs bridging in: 15. This is the number that
    // moves if the exclusion in analyze.ts is ever deleted — membership above
    // does not, by design (see the block comment above this describe).
    expect(analysis.bridged).toBe(14);
  });
});

describe("analyze: T7.2 — working sets are suppressed on the thin history doctor grades degraded on", () => {
  /**
   * A cross-module co-change pattern strong enough to earn its own Louvain
   * community spanning two declared modules (`a` and `b`, via the
   * two-segment directory fallback — no manifest in this fixture). Background
   * churn dilutes the marginal probability of `a/one.ts`/`b/two.ts` the same
   * way every other hub-adjacent fixture in this file does, and gives the
   * graph other components to bridge, so this isn't a degenerate single-edge
   * repo that would pass for reasons unrelated to what's under test.
   */
  function crossModuleRepo(): string {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 12; i++) commits.push({ files: ["a/one.ts", "b/two.ts"] });
    commits.push(...backgroundChurn(15));
    return buildRepo(commits);
  }

  it("reports no working sets when history is below the doctor threshold", () => {
    const repo = crossModuleRepo();
    const thin = { ...DEFAULTS, minCommits: 1000 };
    expect(analyze(repo, thin, { now: NOW }).analysis.workingSets).toEqual([]);
  });

  it("returns the non-empty working sets T7.1 computes once history clears the threshold — suppression is conditional, not a permanent silencing", () => {
    const repo = crossModuleRepo();
    const clear = { ...DEFAULTS, minCommits: 5 };
    const { analysis } = analyze(repo, clear, { now: NOW });
    expect(analysis.workingSets.length).toBeGreaterThan(0);
    expect(analysis.workingSets.some((w) => w.modules.includes("a") && w.modules.includes("b"))).toBe(
      true,
    );
  });

  /**
   * Criterion 3 is written as "absent whenever doctor says degraded", not
   * "absent whenever analysableCommits < minCommits" — those happen to
   * coincide today only because `doctor`'s two `required: true` checks are
   * "repository" (always `ok` on any branch that reaches the grade) and
   * "history depth" (graded by the same `historyIsThin` this suppression
   * calls). Asserting through `minCommits` alone would stay green even if a
   * future `required: true` check broke that coincidence — this test goes
   * through `doctor()` itself so it actually proves the criterion.
   */
  it("suppresses working sets whenever doctor grades the repo degraded — asserted through doctor(), not minCommits", () => {
    const repo = crossModuleRepo();
    const thin = { ...DEFAULTS, minCommits: 1000 };
    expect(doctor(repo, thin).status).toBe("degraded");
    expect(analyze(repo, thin, { now: NOW }).analysis.workingSets).toEqual([]);
  });

  /**
   * The other half of that implication, and the one it is tempting to claim
   * for free: `degraded => suppressed` does NOT make suppression a synonym for
   * `degraded`. `doctor` grades the repository — it takes no `--since` and
   * `runDoctorCommand` passes it none — while `analyze` measures the window it
   * actually harvested. `octograph map --since <recent>` on a deep repo
   * therefore suppresses on history `octograph doctor` reports as `ok`, and
   * that is the correct answer, because the partition being suppressed came
   * from those windowed commits alone.
   *
   * Pinned as behaviour rather than left implicit, because the alternative
   * reading — "the two surfaces agree, full stop" — is the claim the doc
   * comments used to make, and the direction of the divergence is exactly the
   * one nobody notices: a section silently missing from map.md, with a green
   * `doctor` standing next to it. If someone later makes `doctor` window-aware
   * (giving it a `since`, or passing `analyze`'s count into it), this test is
   * where that decision has to be made deliberately.
   *
   * The old commits are committed FIRST so they are ANCESTORS of the recent
   * ones: `git log --since` prunes traversal at the first commit older than
   * the cutoff, so a fixture built the other way round returns zero commits
   * for the window rather than the twelve under test.
   */
  it("also suppresses on a --since window below the threshold, on a repo doctor grades ok", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 15; i++) {
      commits.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`], daysAgo: 400 });
      commits.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`], daysAgo: 400 });
    }
    for (let i = 0; i < 12; i++) commits.push({ files: ["a/one.ts", "b/two.ts"], daysAgo: 0 });
    const repo = buildRepo(commits);

    // 42 analysable commits in full history, 12 inside the window.
    const cfg = { ...DEFAULTS, minCommits: 35 };
    expect(doctor(repo, cfg).status).toBe("ok");

    const full = analyze(repo, cfg, { now: NOW }).analysis;
    expect(full.commitCount).toBe(42);
    expect(full.workingSets.length).toBeGreaterThan(0);

    const windowed = analyze(repo, cfg, { now: NOW, since: "2025-06-01" }).analysis;
    expect(windowed.commitCount).toBe(12);
    expect(windowed.workingSets).toEqual([]);
  });
});
