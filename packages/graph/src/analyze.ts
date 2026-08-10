import { harvest } from "./harvest.js";
import { countPairs } from "./cochange.js";
import { edgeWeight, weighEdges, type Edge } from "./weights.js";
import { detectHubs } from "./hubs.js";
import { bridgeComponents } from "./components.js";
import { louvain } from "./louvain.js";
import { compare, nameCluster, rollUp, type ModuleEdge } from "./rollup.js";
import { declaredSpine, filesByModule, type Spine } from "./spine.js";
import { layerRanks } from "./layers.js";
import { isTestPath } from "./noise.js";
import { remapClusters } from "./stability.js";
import { workingSets, type WorkingSet } from "./working-sets.js";
import { historyIsThin, type Config } from "./config.js";

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
  /**
   * How many of this run's modules inherited a previous run's id through the
   * Jaccard remap (`stability.ts`), versus how many were minted fresh.
   *
   * Sourced from `remapClusters` and `opts.previousClusters` alone — never a
   * placeholder. A module's id counts as "kept" exactly when the remap
   * matched it to an old id (`opts.previousClusters` has that id as a key);
   * `remapClusters` mints every fresh id strictly above `max(old ids)`, so a
   * fresh id can never coincide with an old one and this check cannot
   * misclassify either way. With no `previousClusters` (a first run, or a
   * caller that opts out), every module is fresh by construction — the same
   * behaviour this option replaces.
   */
  clusterIds: { kept: number; fresh: number };
  /**
   * The Louvain communities that DISAGREE with the declared spine — spec D3's
   * "discovered" half. Declared module identity and membership (`modules`
   * above) are untouched by this: a working set is a second, independent read
   * of the same partition, never a mutation of the first.
   *
   * Suppressed to `[]` wholesale when `historyIsThin` (config.ts) says this
   * repo's history is too thin for clustering to mean anything — at THIS
   * layer, not in a renderer, so map.md, the artifact and M6's future bridge
   * all inherit one suppression rather than each carrying a copy. An empty
   * array means either "nothing to report" or "history too thin to say" —
   * criterion 3 requires the section to be absent, not caveated, so nothing
   * downstream needs to tell those two apart.
   */
  workingSets: WorkingSet[];
}

export interface AnalyzeOptions {
  /** Reference time for decay. Passed in for determinism. */
  now: number;
  /** Passed straight through to `git log --since`. */
  since?: string;
  /**
   * The previous run's cluster membership — module id -> member file paths —
   * typically the `clusters` map read back from a committed `clusters.json`
   * via `readArtifact` (see artifact.ts). Fed to `remapClusters` so this run's
   * module ids pin onto the previous run's rather than following whatever
   * order this run's Louvain partition and module sort happen to produce.
   *
   * Deliberately a `Map`, matching `remapClusters`'s own signature, not
   * `StoredGraph` — analyze.ts stays free of file I/O; a caller reading
   * `clusters.json` converts its `Record<number, string[]>` to a `Map` itself.
   *
   * Omitted (or empty) on a first run: every module then gets a fresh id
   * counting up from 0, exactly as `analyze()` behaved before this option
   * existed.
   */
  previousClusters?: Map<number, string[]>;
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

  // A8: tests are excluded from clustering (community detection) ONLY — they
  // stay in `edges`, stay in `impact()`, and stay in `ModuleSummary.members`
  // (declared identity, sourced independently below via `filesByModule`, is
  // untouched by anything clustering does). Left in, they would form
  // test-shaped communities and drag module boundaries toward the test tree:
  // a test co-changes with its subject constantly, and two different
  // modules' test suites tend to co-change with EACH OTHER too (shared CI
  // fixtures, a refactor that touches every `*.test.ts`), which is exactly
  // the kind of bridge that would merge two unrelated modules into one
  // community for a reason that has nothing to do with architecture.
  const testIds = new Set<number>();
  table.files.forEach((path, id) => {
    if (isTestPath(path)) testIds.add(id);
  });

  // Bridge the edge set that clustering will ACTUALLY see. A hub, by
  // definition, touches much of the graph, so it is often the only thing
  // holding two regions in one component. Bridging before hub removal would
  // see a connected graph, add nothing, and then louvain would strip the hub
  // edges and disconnect those regions anyway — reintroducing the long tail of
  // junk single-file modules that A5e exists to prevent. Test ids are excluded
  // for the same reason as hubs, at the same point: bridging AFTER excluding
  // them would waste a synthetic edge connecting two components that
  // clustering immediately re-splits when the test ids underneath the bridge
  // are stripped out below.
  const clusterable = edges.filter(
    (e) => !hubIds.has(e.a) && !hubIds.has(e.b) && !testIds.has(e.a) && !testIds.has(e.b),
  );
  const bridgedEdges = bridgeComponents(clusterable, table.files);
  const synthetic = bridgedEdges.length - clusterable.length;

  const partition = louvain(bridgedEdges, { exclude: new Set([...hubIds, ...testIds]) });
  const byCommunity = new Map<number, number[]>();
  for (const [node, comm] of partition) {
    const list = byCommunity.get(comm);
    if (list) list.push(node);
    else byCommunity.set(comm, [node]);
  }

  const spine = declaredSpine(repoRoot, table.files);

  // The discovered delta: the same `byCommunity` partition read a second way,
  // against `bridgedEdges` — the edge set clustering actually saw, so
  // `nameCluster`'s centrality inside `workingSets` measures the same graph
  // the partition came from, not the fuller (and differently-connected) raw
  // `edges`. Suppressed wholesale when `historyIsThin` — see the doc comment
  // on `Analysis.workingSets` for why this is the right layer for the check.
  const workingSetList = historyIsThin(commits.length, config)
    ? []
    : workingSets(byCommunity, bridgedEdges, table.files, spine.moduleOf);
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

  // The one true derivation of "what files does a declared module contain" —
  // computed once and read by both the reconciliation backstop below and the
  // final `members` field, so the two cannot answer that question two
  // different ways (see the fix for the sibling bug: a row's `members` must
  // be this, not the Louvain community that happened to win the row's name).
  const declaredMembers = filesByModule(table.files, spine.moduleOf);

  for (const [name, ids] of declaredMembers) {
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

  const preliminary = [...merged.entries()]
    // Code units through the shared comparator, never `localeCompare`: it
    // collates by the machine's default locale, so a committed artifact would
    // reorder on nothing but a change of LANG, and it disagrees with the
    // code-unit order used by `rollUp`, `readGraphify`, `Spine.modules` and
    // `pathsOf` above wherever a module directory is capitalised. See
    // `compare` in rollup.ts.
    .sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]))
    // `members` is the DECLARED membership (`declaredMembers.get(name)`), not
    // the community-accumulated id list `merged` sorted just above — see the
    // fix for "members lists a Louvain community's files under a declared
    // module's heading". The sort above still orders by the community count
    // (a real, if now cosmetic, value — see the bug's notes for why that
    // inconsistency is an intentional, separately-tracked follow-up, not a
    // defect this fix corrects).
    .map(([name], i) => ({
      id: i,
      name,
      members: pathsOf(declaredMembers.get(name) ?? []),
      layer: ranks?.get(name) ?? null,
    }));

  // Pin this run's module ids onto the previous run's, so a rerun that
  // changes nothing (or changes one unrelated module) does not relabel every
  // OTHER module just because the size-then-name sort above put it in a
  // different array position. `preliminary`'s own `id` (the sort position) is
  // exactly the "arbitrary insertion order" `remapClusters`'s own doc comment
  // warns about — a real id, but not a STABLE one — so it is used here only as
  // a throwaway key into the remap, never surfaced.
  const previousClusters = opts.previousClusters ?? new Map<number, string[]>();
  const freshClusters = new Map<number, string[]>(preliminary.map((m) => [m.id, m.members]));
  const remap = remapClusters(previousClusters, freshClusters);

  let kept = 0;
  let fresh = 0;
  const modules: ModuleSummary[] = preliminary.map((m) => {
    const stableId = remap.get(m.id) ?? m.id;
    if (previousClusters.has(stableId)) kept++;
    else fresh++;
    return { ...m, id: stableId };
  });

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
      clusterIds: { kept, fresh },
      workingSets: workingSetList,
    },
    edges,
    files: table.files,
    spine,
  };
}
