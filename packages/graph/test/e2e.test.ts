import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCommits, buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { runNode } from "./fixtures/run-node.js";
import { harvest } from "../src/harvest.js";
import { countPairs } from "../src/cochange.js";
import { weighEdges, type Edge } from "../src/weights.js";
import { detectHubs } from "../src/hubs.js";
import { bridgeComponents } from "../src/components.js";
import { louvain } from "../src/louvain.js";
import { remapClusters } from "../src/stability.js";
import { runCli } from "../src/cli.js";
import { estimateTokens } from "../src/render.js";
import type { Report } from "../src/doctor.js";

/**
 * End-to-end proof of the engine's three load-bearing properties, which no
 * single task's unit tests exercise together: determinism, hub suppression,
 * and cluster-id survival across a changed graph.
 *
 * `runPipeline` wires the M1 modules exactly as the (future, config/spine
 * aware) analysis pipeline will: weight, quarantine hubs out of clustering,
 * bridge disconnected components, then cluster. It is test-only — no
 * production module is added by this task.
 *
 * T7.4 (below, "end-to-end: Working sets…") is this file's second kind of
 * end-to-end proof: the mission's own verification task, run through the real
 * CLI (`runCli`) against `map.md` as it is actually written to disk — never
 * against an in-memory `Analysis`, which is what M2 got wrong three times.
 */
interface PipelineResult {
  files: string[];
  edges: Edge[];
  hubIds: Set<number>;
  partition: Map<number, number>;
}

function runPipeline(repoRoot: string, now: number): PipelineResult {
  const commits = harvest(repoRoot);
  const table = countPairs(commits, { now });
  const edges = weighEdges(table);
  const hubIds = detectHubs(edges, table.files.length);
  const clusterable = edges.filter((e) => !hubIds.has(e.a) && !hubIds.has(e.b));
  const bridged = bridgeComponents(clusterable, table.files);
  const partition = louvain(bridged, { exclude: hubIds });
  return { files: table.files, edges, hubIds, partition };
}

/** Node -> community, sorted by node id so array equality is a real check
 *  (a `Map`'s own iteration order already follows insertion, but this keeps
 *  the comparison legible regardless). */
function sortedPartition(partition: Map<number, number>): Array<[number, number]> {
  return [...partition.entries()].sort((a, b) => a[0] - b[0]);
}

/** Group a partition into cluster id -> member file paths: the shape
 *  `remapClusters` consumes. */
function clustersByPath(files: string[], partition: Map<number, number>): Map<number, string[]> {
  const byCommunity = new Map<number, string[]>();
  for (const [node, comm] of partition) {
    const path = files[node];
    if (path === undefined) continue;
    const list = byCommunity.get(comm);
    if (list) list.push(path);
    else byCommunity.set(comm, [path]);
  }
  return byCommunity;
}

/** The cluster id (if any) that has `path` among its members. */
function clusterIdOf(clusters: Map<number, string[]>, path: string): number | undefined {
  for (const [id, members] of clusters) {
    if (members.includes(path)) return id;
  }
  return undefined;
}

const NOW = Date.UTC(2026, 0, 30);

/** Two dense, mutually disconnected regions — a minimal "real module graph". */
function twoRegionCommits(): { files: string[] }[] {
  const commits: { files: string[] }[] = [];
  for (let i = 0; i < 10; i++) commits.push({ files: ["r1a.ts", "r1b.ts", "r1c.ts"] });
  for (let i = 0; i < 10; i++) commits.push({ files: ["r2a.ts", "r2b.ts", "r2c.ts"] });
  return commits;
}

describe("end-to-end: determinism", () => {
  it("two full runs over one fixture repo produce identical partitions", () => {
    const repo = buildRepo(twoRegionCommits());
    const first = runPipeline(repo, NOW);
    const second = runPipeline(repo, NOW);

    // Not merely isomorphic groupings — the exact same community ids, edge
    // weights, and hub set, because nothing in the pipeline may read a clock
    // or an RNG (see cochange/louvain determinism notes).
    expect(sortedPartition(second.partition)).toEqual(sortedPartition(first.partition));
    expect(second.edges).toEqual(first.edges);
    expect([...second.hubIds]).toEqual([...first.hubIds]);
  });
});

describe("end-to-end: hub suppression", () => {
  it("a file in every commit of both regions neither tops the ranking nor merges two genuine communities", () => {
    const commits: { files: string[] }[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1a.ts", "r1b.ts", "r1c.ts", "hub.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2a.ts", "r2b.ts", "r2c.ts", "hub.ts"] });
    // Background churn the hub never touches: dilutes its global marginal
    // below the 100% it has within R1/R2, which is what keeps its nPMI (and
    // so its weighted degree) from decaying to exactly zero — this is the
    // case of a hub that still carries *some* real weight. The complementary
    // case, a file in *literally* every commit, takes a different path
    // through the engine and is covered by the next test; neither stands in
    // for the other.
    for (let i = 0; i < 30; i++) commits.push({ files: [`n${i}a.ts`, `n${i}b.ts`] });

    const repo = buildRepo(commits);
    const { files, edges, hubIds, partition } = runPipeline(repo, NOW);
    const hubIdx = files.indexOf("hub.ts");
    expect(hubIdx).toBeGreaterThanOrEqual(0);

    // Flagged as a hub despite being in every commit that matters, and
    // nothing else is swept up with it.
    expect([...hubIds]).toEqual([hubIdx]);

    // Never tops the ranking: weighEdges sorts strongest-nPMI-first, and
    // every edge touching the hub scores below every genuine (non-hub) pair.
    const hubEdges = edges.filter((e) => e.a === hubIdx || e.b === hubIdx);
    const genuineEdges = edges.filter((e) => e.a !== hubIdx && e.b !== hubIdx);
    expect(hubEdges.length).toBeGreaterThan(0);
    expect(genuineEdges.length).toBeGreaterThan(0);
    const maxHubNpmi = Math.max(...hubEdges.map((e) => e.npmi));
    const minGenuineNpmi = Math.min(...genuineEdges.map((e) => e.npmi));
    expect(maxHubNpmi).toBeLessThan(minGenuineNpmi);
    const topEdge = edges[0];
    if (topEdge === undefined) throw new Error("expected at least one edge");
    expect(topEdge.a === hubIdx || topEdge.b === hubIdx).toBe(false);

    // Never merges two genuine communities: the two regions stay apart, and
    // the hub — correctly quarantined — is a member of neither.
    expect(partition.has(hubIdx)).toBe(false);
    const communityOf = (path: string): number | undefined => {
      const idx = files.indexOf(path);
      return idx < 0 ? undefined : partition.get(idx);
    };
    const r1Communities = new Set(["r1a.ts", "r1b.ts", "r1c.ts"].map(communityOf));
    const r2Communities = new Set(["r2a.ts", "r2b.ts", "r2c.ts"].map(communityOf));
    expect(r1Communities.size).toBe(1);
    expect(r2Communities.size).toBe(1);
    expect(r1Communities).not.toEqual(r2Communities);

    // Contrast: skip quarantine and the hub gets absorbed as a member of one
    // of the two real communities it has no place in — exactly the
    // distortion `detectHubs` + exclusion exists to prevent.
    const naive = louvain(edges);
    const naiveHubCommunity = naive.get(hubIdx);
    expect(naiveHubCommunity).toBeDefined();
    const naiveCommunityOf = (path: string): number | undefined => {
      const idx = files.indexOf(path);
      return idx < 0 ? undefined : naive.get(idx);
    };
    const joinedRegion = ["r1a.ts", "r1b.ts", "r1c.ts", "r2a.ts", "r2b.ts", "r2c.ts"].some(
      (path) => naiveCommunityOf(path) === naiveHubCommunity,
    );
    expect(joinedRegion).toBe(true);
  });

  it("a file in literally every commit neither tops the ranking nor merges two genuine communities", () => {
    // The acceptance criterion's literal fixture: nothing else churns, so the
    // file's marginal is exactly 1. That is not a harder version of the test
    // above — it is a *different code path*, and the test above cannot stand
    // in for it:
    //
    //   P(hub) = 1  =>  pmi = log(pab / (pa * 1)) = 0  =>  npmi = 0
    //
    // Every hub edge is therefore weightless, so the file's weighted degree
    // is 0 — *below* the mean, never three sd above it — and `detectHubs`
    // does not flag it. Quarantine never fires, and the property the previous
    // test asserts (`partition.has(hubIdx) === false`) does not hold here.
    // The two acceptance-criterion properties still do, by a different
    // mechanism, and that is what this test pins.
    const commits: { files: string[] }[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1a.ts", "r1b.ts", "r1c.ts", "hub.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2a.ts", "r2b.ts", "r2c.ts", "hub.ts"] });

    const repo = buildRepo(commits);
    const { files, edges, hubIds, partition } = runPipeline(repo, NOW);
    const hubIdx = files.indexOf("hub.ts");
    expect(hubIdx).toBeGreaterThanOrEqual(0);

    // Degree-based quarantine is blind to this hub — recorded, not endorsed.
    // If `detectHubs` ever grows a marginal-frequency rule, this line is the
    // one that must change, and it should change deliberately.
    expect([...hubIds]).toEqual([]);

    // Never tops the ranking: nPMI alone already sinks every hub edge to 0,
    // strictly below every genuine pair, and the sort puts them last.
    const hubEdges = edges.filter((e) => e.a === hubIdx || e.b === hubIdx);
    const genuineEdges = edges.filter((e) => e.a !== hubIdx && e.b !== hubIdx);
    expect(hubEdges.length).toBe(6);
    expect(genuineEdges.length).toBe(6);
    const maxHubNpmi = Math.max(...hubEdges.map((e) => e.npmi));
    const minGenuineNpmi = Math.min(...genuineEdges.map((e) => e.npmi));
    expect(maxHubNpmi).toBe(0);
    expect(maxHubNpmi).toBeLessThan(minGenuineNpmi);
    const topEdge = edges[0];
    if (topEdge === undefined) throw new Error("expected at least one edge");
    expect(topEdge.a === hubIdx || topEdge.b === hubIdx).toBe(false);

    // Never merges two genuine communities: R1 and R2 stay apart even though
    // the hub co-changes with all six of their files and nothing quarantined
    // it — the zero weights keep it out of Louvain's adjacency entirely.
    const communityOf = (path: string): number | undefined => {
      const idx = files.indexOf(path);
      return idx < 0 ? undefined : partition.get(idx);
    };
    const r1Communities = new Set(["r1a.ts", "r1b.ts", "r1c.ts"].map(communityOf));
    const r2Communities = new Set(["r2a.ts", "r2b.ts", "r2c.ts"].map(communityOf));
    expect(r1Communities.size).toBe(1);
    expect(r2Communities.size).toBe(1);
    expect(r1Communities).not.toEqual(r2Communities);

    // Un-quarantined and weightless, the file reaches Louvain as an isolated
    // component, so `bridgeComponents` attaches it to one region by directory
    // proximity — it ends up *inside* a genuine module rather than outside
    // every module. Asserted so a change in either mechanism surfaces here
    // instead of silently in the committed artifact.
    const hubCommunity = partition.get(hubIdx);
    expect(hubCommunity).toBeDefined();
    const [r1Community] = r1Communities;
    const [r2Community] = r2Communities;
    expect(hubCommunity === r1Community || hubCommunity === r2Community).toBe(true);
  });
});

describe("end-to-end: cluster id survival", () => {
  it("keeps the untouched region's cluster id after the other region's history changes", () => {
    const repo = buildRepo(twoRegionCommits());
    const before = runPipeline(repo, NOW);
    const oldClusters = clustersByPath(before.files, before.partition);

    // Mutate region 2's history only; region 1 is never touched again.
    appendCommits(repo, [
      { files: ["r2a.ts", "r2b.ts", "r2c.ts", "r2d.ts"] },
      { files: ["r2a.ts", "r2b.ts", "r2c.ts", "r2d.ts"] },
      { files: ["r2a.ts", "r2b.ts", "r2c.ts", "r2d.ts"] },
    ]);

    const after = runPipeline(repo, Date.UTC(2026, 1, 5));
    const newClusters = clustersByPath(after.files, after.partition);
    const remap = remapClusters(oldClusters, newClusters);

    const oldR1Id = clusterIdOf(oldClusters, "r1a.ts");
    const newR1Id = clusterIdOf(newClusters, "r1a.ts");
    if (oldR1Id === undefined || newR1Id === undefined) {
      throw new Error("expected region 1 to form its own cluster in both runs");
    }

    // The raw Louvain id for region 1 is not even guaranteed to be the same
    // number run to run — new files shift node ids — which is exactly why
    // remapClusters exists rather than trusting the raw id directly.
    expect(remap.get(newR1Id)).toBe(oldR1Id);
    // And its membership itself never moved.
    expect([...(newClusters.get(newR1Id) ?? [])].sort()).toEqual(
      [...(oldClusters.get(oldR1Id) ?? [])].sort(),
    );
  });
});

/**
 * T7.4 — the mission's own verification task. Every unit-level suite already
 * covers its own layer in isolation: `working-sets.test.ts` the filter,
 * `render.test.ts` the section (against a hand-written `Analysis`),
 * `analyze.test.ts` the suppression (against `analyze()`'s return value
 * directly). None of those prove the section actually reaches a `map.md`
 * written to disk by the real CLI — which is exactly the gap M2 left three
 * times over (the mission note this task is named after). Every assertion
 * below reads the RENDERED file back off disk after a `runCli(...)` call;
 * none reads `Analysis`.
 */
describe("end-to-end: Working sets in the RENDERED map.md, driven through the real CLI", () => {
  const T4_NOW = Date.UTC(2026, 0, 30);

  /**
   * Background churn that touches none of the files under test — dilutes
   * marginal probability the same way `analyze.test.ts`'s own helper of the
   * same name does, and gives the graph other components to bridge so a
   * cross-module pair's community isn't a degenerate single-edge graph (see
   * `.agents/knowledge/testing/graph-fixture-two-module-boundary-needs-a-
   * third-unrelated-component.md`). Duplicated here rather than imported: it
   * is fixture scaffolding local to each test file, not one of the
   * single-spelled production rules `conventions.test.ts` guards.
   */
  function backgroundChurn(pairs: number): CommitSpec[] {
    const out: CommitSpec[] = [];
    for (let i = 0; i < pairs; i++) {
      out.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`] });
      out.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`] });
    }
    return out;
  }

  /**
   * One cross-module co-change pattern strong enough to earn its own Louvain
   * community, plus background churn. 42 commits total — comfortably below
   * the default `minCommits` (200), so this fixture doubles as both "history
   * too thin" (used as-is) and "history cleared" (used with `--min-commits`
   * overridden low) depending on the flags a test passes to `runCli`.
   *
   * SIX files across two modules (`a/` and `b/`, the two-segment directory
   * fallback — no manifest in this fixture), deliberately not two. A two-file
   * set renders a header claiming "2 files" above two lines, and a count that
   * small agrees with its own membership under any renderer at all, including
   * one that sliced the section by LINE and cut a set mid-membership. The
   * defect this mission is named for is a header claiming N above fewer than
   * N lines, so the fixture that verifies it must be able to exhibit it.
   */
  function crossModuleRepo(): string {
    const together = ["a/f0.ts", "a/f1.ts", "a/f2.ts", "b/g0.ts", "b/g1.ts", "b/g2.ts"];
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 12; i++) commits.push({ files: together });
    commits.push(...backgroundChurn(15));
    return buildRepo(commits);
  }

  function readMap(repo: string): string {
    return readFileSync(join(repo, ".octograph", "map.md"), "utf8");
  }

  /** One entry of the rendered section, split into the CLAIMS its header
   *  makes and the membership the same render actually put beneath it. */
  interface RenderedSet {
    /** The name the header states — a file path, per spec A5c. */
    name: string;
    /** The file count the header CLAIMS ("— N files across …"). */
    claimed: number;
    /** The declared modules the header CLAIMS the set spans. */
    modules: string[];
    /** The `  - path` lines actually rendered under that header. */
    files: string[];
  }

  const SET_HEADER = /^- \*\*(.+?)\*\* — (\d+) files across (.+)$/;

  /**
   * Parse the rendered Working sets section back into the claims it publishes.
   * Line-oriented on purpose: a header's claim and the lines beneath it are
   * only comparable if both are read off the same rendered text, which is the
   * whole difference between this suite and `render.test.ts`'s hand-written
   * `Analysis`.
   */
  function parseWorkingSets(rendered: string): RenderedSet[] {
    const at = rendered.indexOf("## Working sets");
    if (at === -1) return [];
    const out: RenderedSet[] = [];
    for (const line of rendered.slice(at).split("\n")) {
      const header = SET_HEADER.exec(line);
      if (header !== null) {
        const [, name, claimed, modules] = header;
        if (name === undefined || claimed === undefined || modules === undefined) continue;
        out.push({ name, claimed: Number(claimed), modules: modules.split(", "), files: [] });
        continue;
      }
      const member = /^ {2}- (.+)$/.exec(line);
      const current = out[out.length - 1];
      if (member?.[1] !== undefined && current !== undefined) current.files.push(member[1]);
    }
    return out;
  }

  /**
   * Module headings from the `## Modules` SECTION alone, never from the whole
   * file. A working set's own entry is spelled `- **<path>** — …`, the same
   * shape as a module row, so harvesting `- **x**` document-wide makes the
   * Working sets section a witness for its own claims: a set naming a module
   * with no heading would still pass whenever some other set happened to be
   * NAMED that. The criterion says "a heading in the '## Modules' section of
   * that same file", and that is what this reads.
   */
  function moduleHeadings(rendered: string): Set<string> {
    const at = rendered.indexOf("## Modules");
    expect(at, "map.md has no ## Modules section").toBeGreaterThanOrEqual(0);
    const rest = rendered.slice(at + "## Modules".length);
    const next = rest.indexOf("\n## ");
    const section = next === -1 ? rest : rest.slice(0, next);
    return new Set(
      [...section.matchAll(/^- \*\*(.+?)\*\*/gm)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined),
    );
  }

  /**
   * Every claim the rendered section makes, checked against what the same
   * render put beneath it — the count, the span, the name, and the modules'
   * headings. This campaign's recurring defect is a claim that outran its own
   * computation (`clusterIds` hardcoded, a count meaning something narrower
   * than it said, an edge naming a module with no heading), and each one
   * passed the tests that existed. Asserted here for EVERY rendered set on
   * EVERY fixture below, not once on a happy path.
   */
  function expectRenderedSetsHonest(rendered: string): RenderedSet[] {
    const sets = parseWorkingSets(rendered);
    // Precondition: there is something to check. Without it every loop below
    // is vacuously true of a renderer that emits no sets at all.
    expect(sets.length, "no working set entries parsed out of the render").toBeGreaterThan(0);
    const headings = moduleHeadings(rendered);
    for (const s of sets) {
      expect(
        s.files.length,
        `"${s.name}" claims ${s.claimed} files, ${s.files.length} rendered beneath it`,
      ).toBe(s.claimed);
      // A working set IS the boundary-crossing case; a header claiming one
      // module is the filter having let an agreeing community through.
      expect(s.modules.length, `"${s.name}" claims to span ${s.modules.join(", ")}`)
        .toBeGreaterThanOrEqual(2);
      // "Named by its most central member" — a name that is not one of the
      // set's own files is a dangling reference inside the entry itself.
      expect(s.files, `"${s.name}" is not among its own rendered members`).toContain(s.name);
      for (const m of s.modules) {
        expect(
          headings.has(m),
          `"${m}" is named by working set "${s.name}" but has no heading in ## Modules`,
        ).toBe(true);
      }
    }
    return sets;
  }

  it("(a) writes no '## Working sets' heading at all when the repo is below the doctor threshold", () => {
    const repo = crossModuleRepo();

    // Precondition, through the CLI: this repo really is what `doctor`
    // grades degraded, not merely a repo with few commits.
    const doctorResult = runCli(["doctor", "--json"], repo, T4_NOW);
    const doctorReport = JSON.parse(doctorResult.stdout) as Report;
    expect(doctorReport.status).toBe("degraded");

    const mapResult = runCli(["map"], repo, T4_NOW);
    expect(mapResult.code).toBe(0);

    // Not "an empty section" — no heading at all. Criterion 3 is written as
    // "absent, not caveated" (config.ts's own doc comment on
    // `historyIsThin`), and this is the rendered artifact's half of that.
    expect(readMap(repo)).not.toContain("## Working sets");
  });

  it("(b) renders the section once history clears the threshold, and every claim it makes matches what produced it", () => {
    const repo = crossModuleRepo();
    const mapResult = runCli(["map", "--min-commits", "5"], repo, T4_NOW);
    expect(mapResult.code).toBe(0);

    const rendered = readMap(repo);
    expect(rendered).toContain("## Working sets");

    const sets = expectRenderedSetsHonest(rendered);
    // Precondition on the FIXTURE, not on the renderer: the count claim above
    // is only load-bearing if some set claims more than the two files a
    // degenerate pair would. Without this, a fixture change back to two-file
    // sets would silently retire the assertion rather than fail.
    expect(Math.max(...sets.map((s) => s.claimed))).toBeGreaterThan(2);
  });

  it("(c) the rendered section contains no recommendation vocabulary", () => {
    const repo = crossModuleRepo();
    const mapResult = runCli(["map", "--min-commits", "5"], repo, T4_NOW);
    expect(mapResult.code).toBe(0);

    const rendered = readMap(repo);
    expect(rendered).toContain("## Working sets");
    const section = rendered.slice(rendered.indexOf("## Working sets")).toLowerCase();
    // Same vocabulary list `render.test.ts` pins at the unit level — this
    // test proves the same property survives the real CLI and a real file.
    for (const word of ["should", "consider", "recommend", "merge these", "split", "refactor"]) {
      expect(section).not.toContain(word);
    }
  });

  it("(d) writes byte-identical map.md across two runs over an unchanged commit, section present in both", () => {
    const repo = crossModuleRepo();

    const first = runCli(["map", "--min-commits", "5"], repo, T4_NOW);
    expect(first.code).toBe(0);
    const firstText = readMap(repo);
    expect(firstText).toContain("## Working sets");
    expectRenderedSetsHonest(firstText);

    // No commits added between runs — the CLI is invoked a second time over
    // the exact same history, exactly as a real "run octograph again" would.
    const second = runCli(["map", "--min-commits", "5"], repo, T4_NOW);
    expect(second.code).toBe(0);
    const secondText = readMap(repo);
    expect(secondText).toContain("## Working sets");

    expect(secondText).toBe(firstText);
  });

  it("(e) keeps the rendered map.md within budgetTokens on a fixture producing many working sets", () => {
    const commits: CommitSpec[] = [];
    // 20 independent cross-module pairs — each its own component, each
    // spanning two declared modules — plus background churn so no single
    // pair's community is a degenerate single-edge graph.
    for (let i = 0; i < 20; i++) {
      commits.push({ files: [`a${i}/one.ts`, `b${i}/two.ts`] });
      commits.push({ files: [`a${i}/one.ts`, `b${i}/two.ts`] });
    }
    commits.push(...backgroundChurn(15));
    const repo = buildRepo(commits);

    // First, a generous budget: proves the fixture really produces MANY
    // working sets, not just one or two — otherwise the tight-budget
    // assertion below would pass trivially for a renderer with no
    // truncation logic at all.
    const generous = runCli(["map", "--min-commits", "5"], repo, T4_NOW);
    expect(generous.code).toBe(0);
    const generousText = readMap(repo);
    const setEntries = expectRenderedSetsHonest(generousText);
    expect(setEntries.length).toBeGreaterThanOrEqual(10);
    expect(estimateTokens(generousText)).toBeGreaterThan(400);

    // Now a tight budget, over the same history: the written file must obey
    // it, read back off disk exactly as a real consumer would read it.
    const tight = runCli(["map", "--min-commits", "5", "--budget", "400"], repo, T4_NOW);
    expect(tight.code).toBe(0);
    const tightText = readMap(repo);
    expect(estimateTokens(tightText)).toBeLessThanOrEqual(400);

    // What the budget actually did here, stated rather than left implied: at
    // 400 tokens this fixture's whole section is cut, so the assertion above
    // is about a map.md with NO working sets in it. That is a legitimate
    // outcome — but a reader is still owed the count that was dropped, and a
    // test that only weighed the file would pass identically if the section
    // had vanished with no note at all. Test (g) below covers the other
    // state, where the section survives truncated.
    expect(tightText).toContain("working set(s) truncated to fit the token budget.");
    // Whichever state the loop lands in, every entry it DID render still has
    // to be honest — asserted as a disjunction so a future shrink loop that
    // keeps one set here fails only if that set lies, not merely because it
    // kept one.
    if (tightText.includes("## Working sets")) expectRenderedSetsHonest(tightText);
  });

  it("(g) keeps every surviving entry whole and every module it names headed when the budget truncates the section itself", () => {
    const commits: CommitSpec[] = [];
    // Four independent six-file communities, each spanning two declared
    // modules — wide sets, so the section is the one that occupies the most
    // LINES and is therefore what the shrink loop charges first.
    for (let s = 0; s < 4; s++) {
      const together = [
        `a${s}/f0.ts`, `a${s}/f1.ts`, `a${s}/f2.ts`,
        `b${s}/g0.ts`, `b${s}/g1.ts`, `b${s}/g2.ts`,
      ];
      for (let i = 0; i < 8; i++) commits.push({ files: together });
    }
    commits.push(...backgroundChurn(15));
    const repo = buildRepo(commits);

    const generous = runCli(["map", "--min-commits", "5"], repo, T4_NOW);
    expect(generous.code).toBe(0);
    const all = expectRenderedSetsHonest(readMap(repo));

    const tight = runCli(["map", "--min-commits", "5", "--budget", "400"], repo, T4_NOW);
    expect(tight.code).toBe(0);
    const rendered = readMap(repo);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(400);

    // The state this test exists for, asserted as a precondition: the section
    // is PRESENT and TRUNCATED. Everything below is vacuous in either of the
    // other two states (whole section, or no section at all), and both are
    // one fixture edit away — which is how a budget test stops exercising the
    // path it was written for without ever going red.
    expect(rendered).toContain("## Working sets");
    expect(rendered).toContain("working set(s) truncated to fit the token budget.");
    const kept = expectRenderedSetsHonest(rendered);
    expect(kept.length).toBeLessThan(all.length);
  });

  it(
    "(f) the esbuild pack bundle runs under bare node with no node_modules, and its map command emits the section",
    () => {
      const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
      // Built straight into this test's own temp directory — never into
      // `dist/octograph.mjs` (that path has exactly one writer,
      // `bundle.test.ts`; Vitest runs test files in parallel, and building it
      // here too would race that file's own build/copy over the same bytes).
      const isolated = join(mkdtempClean("octograph-t4-bundle-"), "octograph.mjs");
      execFileSync("node", ["scripts/bundle.mjs", isolated], { cwd: PKG_ROOT, stdio: "pipe" });

      const repo = crossModuleRepo();
      // Under the OS temp dir there is no `node_modules` anywhere up the
      // chain — the same self-containment precondition `bundle.test.ts`
      // checks for its own fixture.
      expect(existsSync(join(repo, "node_modules"))).toBe(false);

      const result = runNode([isolated, "map", "--min-commits", "5"], repo);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.code, `octograph exited ${result.code}: ${result.stderr}`).toBe(0);

      const rendered = readMap(repo);
      expect(rendered).toContain("## Working sets");
      // The bundle is a separate build of the same source, so it is a
      // separate chance for the section to arrive malformed — the claims are
      // checked against ITS output too, not assumed from the in-process run.
      expectRenderedSetsHonest(rendered);
    },
    30_000,
  );
});
