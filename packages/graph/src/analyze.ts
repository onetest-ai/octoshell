import { harvest } from "./harvest.js";
import { countPairs } from "./cochange.js";
import { weighEdges, type Edge } from "./weights.js";
import { detectHubs } from "./hubs.js";
import { bridgeComponents } from "./components.js";
import { louvain } from "./louvain.js";
import { nameCluster, rollUp, type ModuleEdge } from "./rollup.js";
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
  const homeOf = new Map<number, number>();
  for (const hub of hubIds) {
    const votes = new Map<number, number>();
    for (const e of edges) {
      const other = e.a === hub ? e.b : e.b === hub ? e.a : -1;
      if (other === -1 || hubIds.has(other)) continue;
      const comm = partition.get(other);
      if (comm === undefined) continue;
      votes.set(comm, (votes.get(comm) ?? 0) + Math.max(0, e.npmi));
    }
    let best = -1;
    let bestWeight = -1;
    for (const [comm, w] of [...votes].sort((x, y) => x[0] - y[0])) {
      if (w > bestWeight) {
        best = comm;
        bestWeight = w;
      }
    }
    if (best !== -1) homeOf.set(hub, best);
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

  const modules: ModuleSummary[] = [...merged.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
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
