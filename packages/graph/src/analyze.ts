import { harvest } from "./harvest.js";
import { countPairs } from "./cochange.js";
import { edgeWeight, weighEdges, type Edge } from "./weights.js";
import { detectHubs } from "./hubs.js";
import { bridgeComponents } from "./components.js";
import { louvain } from "./louvain.js";
import { compare, nameCluster, rollUp, type ModuleEdge } from "./rollup.js";
import { declaredSpine, filesByModule, type Spine } from "./spine.js";
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
  /**
   * Whether `moduleEdges` carries a DIRECTION, or only a symmetric coupling.
   *
   * `moduleEdges` has two possible producers and they do not mean the same
   * thing. `readGraphify` emits a declared import edge: `from` really does
   * depend on `to`. `rollUp` projects co-change, which has no direction at all
   * — it orders the endpoints lexicographically purely to key the accumulator,
   * so a rendered `from → to` would assert a dependency the data cannot
   * support, and would assert it BACKWARDS about half the time (`web` importing
   * `api` rolls up to `api → web`). A consumer must be able to tell the two
   * apart without re-deriving the rule, so it is stated here, once, by the same
   * expression that picks the edges.
   */
  moduleEdgesDirected: boolean;
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
  // One expression decides both which edges are reported and whether they carry
  // a direction — see `Analysis.moduleEdgesDirected`. Splitting the two apart
  // is how a renderer ends up drawing an arrow on a symmetric edge.
  const moduleEdgesDirected = spine.imports.length > 0;
  const moduleEdges = moduleEdgesDirected
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

  // Declared-identity backstop. A hub that DID get a vote (unlike the unvoted
  // case just above) can still be reattached into a community named for a
  // completely different declared module — a root-level file whose module is
  // "." voted into whichever package it churns with most, say — and if no
  // other file shares that hub's declared name, the name never becomes a key
  // in `merged` at all: not missing a file, missing ENTIRELY. `moduleEdges`
  // below has no such gap, because `rollUp`/`readGraphify` key every edge by
  // `spine.moduleOf` over the FULL edge set, oblivious to which community won
  // any hub — so the map would carry a dependency line to a module with no
  // heading of its own. Reconcile by construction, not by chance: every name
  // `filesByModule` can produce for a harvested file must end up a key here,
  // pulling its files out of wherever a naming vote sent them if it has to.
  // A name that already has a merged entry keeps whatever community(ies) chose
  // it — communities merging under one declared name is the expected case
  // (see the "two communities, one module" render test), and is left alone.
  const homeOfId = new Map<number, string>();
  for (const [name, ids] of merged) for (const id of ids) homeOfId.set(id, name);

  for (const [name, ids] of filesByModule(table.files, spine.moduleOf)) {
    if (merged.has(name)) continue;
    for (const id of ids) {
      const oldName = homeOfId.get(id);
      if (oldName === undefined) continue;
      const bucket = merged.get(oldName);
      if (bucket === undefined) continue;
      const idx = bucket.indexOf(id);
      if (idx !== -1) bucket.splice(idx, 1);
    }
    merged.set(name, ids);
  }
  // A move above can empty a donor bucket; an empty module is not a module.
  for (const [name, ids] of [...merged]) if (ids.length === 0) merged.delete(name);

  // Second half of the same backstop, for the modules `filesByModule` CANNOT
  // produce: a declared module that a `moduleEdges` row names but no harvested
  // file lives in. Graphify indexes the whole tree while `harvest` only sees
  // commits inside the `--since` window and under the mega-commit cap, so a
  // package with no analysable churn is an ordinary endpoint in `spine.imports`
  // and has no file to be grouped by. Without this it would be a dependency
  // line pointing at a module with no heading — the same dangling reference the
  // loop above closes for the co-change branch. `spine.modules` is the one
  // place that union is computed (see spine.ts), so the two cannot drift.
  //
  // Rendered as a real heading with zero files, which is the true statement:
  // the module exists and is depended upon, and this history window says
  // nothing about it. It sorts last (member count descending) and is therefore
  // the first thing the token budget drops.
  for (const name of spine.modules) if (!merged.has(name)) merged.set(name, []);

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
      moduleEdgesDirected,
      hubs: pathsOf([...hubIds]),
      bridged: synthetic,
      clusterIds: { kept: 0, fresh: modules.length },
    },
    edges,
    files: table.files,
    spine,
  };
}
