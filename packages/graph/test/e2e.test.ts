import { describe, expect, it } from "vitest";
import { appendCommits, buildRepo } from "./fixtures/repo.js";
import { harvest } from "../src/harvest.js";
import { countPairs } from "../src/cochange.js";
import { weighEdges, type Edge } from "../src/weights.js";
import { detectHubs } from "../src/hubs.js";
import { bridgeComponents } from "../src/components.js";
import { louvain } from "../src/louvain.js";
import { remapClusters } from "../src/stability.js";

/**
 * End-to-end proof of the engine's three load-bearing properties, which no
 * single task's unit tests exercise together: determinism, hub suppression,
 * and cluster-id survival across a changed graph. map.md rendering and the
 * CLI arrive in M2/M3 — out of scope here.
 *
 * `runPipeline` wires the M1 modules exactly as the (future, config/spine
 * aware) analysis pipeline will: weight, quarantine hubs out of clustering,
 * bridge disconnected components, then cluster. It is test-only — no
 * production module is added by this task.
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
  it("a file touched in every commit neither tops the ranking nor merges two genuine communities", () => {
    const commits: { files: string[] }[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1a.ts", "r1b.ts", "r1c.ts", "hub.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2a.ts", "r2b.ts", "r2c.ts", "hub.ts"] });
    // Background churn the hub never touches: dilutes its global marginal
    // below the 100% it has within R1/R2, which is what keeps its nPMI (and
    // so its weighted degree) from decaying to exactly zero — the
    // interesting case is a hub that still carries *some* real weight, not
    // one nPMI has already zeroed out on its own.
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
