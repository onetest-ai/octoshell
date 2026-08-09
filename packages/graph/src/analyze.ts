import { harvest } from "./harvest.js";
import { countPairs } from "./cochange.js";
import { edgeWeight, weighEdges, type Edge } from "./weights.js";
import { detectHubs } from "./hubs.js";
import { bridgeComponents } from "./components.js";
import { louvain } from "./louvain.js";
import { compare, nameCluster, rollUp, type ModuleEdge } from "./rollup.js";
import { declaredSpine, type Spine } from "./spine.js";
import { layerRanks } from "./layers.js";
import type { Config } from "./config.js";

export interface ModuleSummary {
  id: number;
  name: string;
  members: string[];
  layer: number | null;
}

export interface Analysis {
  commitCount: number;
  fileCount: number;
  spineSource: "graphify" | "manifests" | "directories";
  modules: ModuleSummary[];
  moduleEdges: ModuleEdge[];
  hubs: string[];
  bridged: number;
  clusterIds: { kept: number; fresh: number };
}

export interface AnalyzeOptions {
  /** Reference time for decay. Passed in for determinism. */
  now: number;
  /** Passed straight through to `git log --since`. */
  since?: string;
}

export function analyze(repoRoot: string, config: Config, opts: AnalyzeOptions): {
  analysis: Analysis;
  edges: Edge[];
  files: string[];
  spine: Spine;
} {
  const commits = harvest(repoRoot, {
    maxCommitFiles: config.maxCommitFiles,
    since: opts.since,
  });
  const table = countPairs(commits, { now: opts.now, halfLifeDays: config.halfLifeDays });
  const edges = weighEdges(table, { minSupport: config.minSupport });

  const hubIds = detectHubs(edges, table.files.length, { zThreshold: config.hubZThreshold });

  // Bridge the edge set that clustering will ACTUALLY see. A hub, by
  // definition, touches much of the graph, so it is often the only thing
  // holding two regions in one component. Bridging before hub removal would
  // see a connected graph, add nothing, and then louvain would strip the hub
  // edges and disconnect those regions anyway — reintroducing the long tail of
  // junk single-file modules that A5e exists to prevent.
  const clusterable = edges.filter((e) => !hubIds.has(e.a) && !hubIds.has(e.b));
  const bridgedEdges = bridgeComponents(clusterable, table.files);
  const synthetic = bridgedEdges.length - clusterable.length;

  const partition = louvain(bridgedEdges, { exclude: hubIds });
  const byCommunity = new Map<number, number[]>();
  for (const [node, comm] of partition) {
    const list = byCommunity.get(comm);
    if (list) list.push(node);
    else byCommunity.set(comm, [node]);
  }

  const spine = declaredSpine(repoRoot, table.files);
  const moduleEdges = spine.imports.length > 0
    ? spine.imports
    : rollUp(edges, table.files, spine.moduleOf);
  const ranks = layerRanks(spine.modules, spine.imports);

  // A4, second half: hubs were excluded from clustering, now reattach them by
  // plurality vote so real files do not silently vanish from the map.
  //
  // Hub ids are iterated in ascending order rather than in `Set` insertion
  // order: the reattachment below feeds module membership, which reaches a
  // committed artifact, so the order must be a property of the data and not of
  // how `detectHubs` happened to fill its set.
  const homeOf = new Map<number, number>();
  /** Hubs no community voted for — see the declared-module fallback below. */
  const unvoted: number[] = [];
  for (const hub of [...hubIds].sort((x, y) => x - y)) {
    const votes = new Map<number, number>();
    for (const e of edges) {
      const other = e.a === hub ? e.b : e.b === hub ? e.a : -1;
      if (other === -1 || hubIds.has(other)) continue;
      const comm = partition.get(other);
      if (comm === undefined) continue;
      // Through `edgeWeight`, exactly as louvain, detectHubs, bridgeComponents
      // and rollUp read a weight. Open-coding the floor here would make this
      // vote the one consumer measuring a different graph from the clustering
      // it is voting into — the divergence that put negative-weight module
      // edges into a committed artifact once already (see weights.ts).
      votes.set(comm, (votes.get(comm) ?? 0) + edgeWeight(e));
    }
    let best = -1;
    let bestWeight = -1;
    for (const [comm, w] of [...votes].sort((x, y) => x[0] - y[0])) {
      if (w > bestWeight) {
        best = comm;
        bestWeight = w;
      }
    }
    if (best === -1) unvoted.push(hub);
    else homeOf.set(hub, best);
  }

  const pathsOf = (ids: number[]): string[] =>
    ids
      .map((n) => table.files[n])
      .filter((p): p is string => p !== undefined)
      .sort();

  // Name each community by its most central member, mapped through the spine.
  // Two communities can resolve to the same declared module — which is the
  // EXPECTED case, since declared and discovered structure disagreeing is the
  // whole premise — so merge them rather than emitting duplicate headings.
  const merged = new Map<string, number[]>();
  for (const [comm, members] of [...byCommunity.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0] - b[0],
  )) {
    const primary = nameCluster(members, bridgedEdges, table.files, 1)[0];
    const name = primary === undefined ? `cluster-${comm}` : spine.moduleOf(primary);
    const attached = [...members];
    for (const [hub, home] of homeOf) if (home === comm) attached.push(hub);
    const existing = merged.get(name);
    if (existing) existing.push(...attached);
    else merged.set(name, attached);
  }

  // A hub only gets a vote from a neighbour that *has* a community, and a
  // neighbour only has one if it survived into `clusterable` — i.e. if it holds
  // an edge that touches no hub. A file whose every co-change partner is
  // quarantined therefore casts no vote, and a hub whose neighbours are all
  // such files (a config file committed pairwise with each leaf it configures,
  // and nothing else) collects none at all. The plurality vote alone then drops
  // it silently: it is excluded from clustering, absent from every community,
  // and reaches the artifact only as a name in `hubs` — the exact
  // disappearance the vote exists to prevent.
  //
  // Fall back to the DECLARED module rather than to an arbitrary community.
  // Co-change has no opinion about this file, so inventing one by parking it in
  // the largest cluster would state a coupling no commit backs; the spine, on
  // the other hand, already knows where the path lives.
  for (const hub of unvoted) {
    const path = table.files[hub];
    if (path === undefined) continue;
    const name = spine.moduleOf(path);
    const existing = merged.get(name);
    if (existing) existing.push(hub);
    else merged.set(name, [hub]);
  }

  const modules: ModuleSummary[] = [...merged.entries()]
    // Code units through the shared comparator, never `localeCompare`: it
    // collates by the machine's default locale, so a committed artifact would
    // reorder on nothing but a change of LANG, and it disagrees with the
    // code-unit order used by `rollUp`, `readGraphify`, `Spine.modules` and
    // `pathsOf` above wherever a module directory is capitalised. See
    // `compare` in rollup.ts.
    .sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]))
    .map(([name, members], i) => ({
      id: i,
      name,
      members: pathsOf(members),
      layer: ranks?.get(name) ?? null,
    }));

  return {
    analysis: {
      commitCount: commits.length,
      fileCount: table.files.length,
      spineSource: spine.source,
      modules,
      moduleEdges,
      hubs: pathsOf([...hubIds]),
      bridged: synthetic,
      clusterIds: { kept: 0, fresh: modules.length },
    },
    edges,
    files: table.files,
    spine,
  };
}
