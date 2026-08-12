import { edgeWeight, type Edge } from "./weights.js";

export interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
}

/**
 * PageRank over the undirected projection.
 *
 * Undirected specifically so hub-like nodes (touched by everything) and
 * authority-like nodes (everything touches them) rank comparably instead of one
 * drowning the other. From wikis' `select_central_symbols`.
 *
 * Scores the subgraph *induced by* `nodes`: an edge with an endpoint outside
 * the set is not part of this graph and is dropped whole. Applying such an edge
 * in only the direction whose endpoint happens to exist would push rank onto a
 * node the iteration never visits, so that mass would leave the total instead
 * of being redistributed — every node with an outbound edge to the outside
 * would come out silently depressed, and the returned map would carry ids the
 * caller never asked about.
 */
export function pageRank(
  edges: Edge[],
  nodes: number[],
  damping = 0.85,
  iterations = 40,
): Map<number, number> {
  const adj = new Map<number, Array<[number, number]>>();
  const strength = new Map<number, number>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    const fromAdj = adj.get(e.a);
    const toAdj = adj.get(e.b);
    if (fromAdj === undefined || toAdj === undefined) continue;
    const w = edgeWeight(e);
    if (w === 0) continue;
    fromAdj.push([e.b, w]);
    toAdj.push([e.a, w]);
    strength.set(e.a, (strength.get(e.a) ?? 0) + w);
    strength.set(e.b, (strength.get(e.b) ?? 0) + w);
  }

  const n = nodes.length;
  let rank = new Map(nodes.map((x) => [x, 1 / n]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((x) => [x, (1 - damping) / n]));
    for (const node of nodes) {
      const share = (rank.get(node) ?? 0) * damping;
      const total = strength.get(node) ?? 0;
      if (total === 0) {
        for (const other of nodes) next.set(other, (next.get(other) ?? 0) + share / n);
        continue;
      }
      for (const [nb, w] of adj.get(node) ?? []) {
        next.set(nb, (next.get(nb) ?? 0) + (share * w) / total);
      }
    }
    rank = next;
  }
  return rank;
}

/**
 * PageRank over the undirected module graph, for ranking MODULES rather than
 * files.
 *
 * A sibling of {@link pageRank}, not a caller of it: `pageRank` reads numeric
 * node ids and `Edge[]`, whose weight is read through `edgeWeight` because
 * `Edge.npmi` is a raw signed value that still needs its floor applied.
 * `ModuleEdge` has neither of those — its nodes are module NAMES (strings)
 * and its `weight` is already a resolved, non-negative number (see
 * `rollUp`/`readGraphify`), so there is no floor left to apply and genericising
 * `pageRank` over both node-id shapes would cost more type complexity than the
 * ~15 lines this duplicates. Kept as its own function rather than sharing code
 * so the two cannot silently drift onto different node/weight shapes — mirror
 * `pageRank`'s algorithm exactly (same damping walk, same "no outgoing weight"
 * redistribution) if either changes.
 *
 * Scores the subgraph *induced by* `modules`, exactly as `pageRank` does for
 * `nodes`: an edge with an endpoint outside the set is dropped whole rather
 * than applied one-sided, so mass is never pushed onto (or leaked from) a
 * module the caller did not ask about.
 */
export function modulePageRank(
  edges: ModuleEdge[],
  modules: string[],
  damping = 0.85,
  iterations = 40,
): Map<string, number> {
  const adj = new Map<string, Array<[string, number]>>();
  const strength = new Map<string, number>();
  for (const m of modules) adj.set(m, []);
  for (const e of edges) {
    const fromAdj = adj.get(e.from);
    const toAdj = adj.get(e.to);
    if (fromAdj === undefined || toAdj === undefined) continue;
    if (e.weight === 0) continue;
    fromAdj.push([e.to, e.weight]);
    toAdj.push([e.from, e.weight]);
    strength.set(e.from, (strength.get(e.from) ?? 0) + e.weight);
    strength.set(e.to, (strength.get(e.to) ?? 0) + e.weight);
  }

  const n = modules.length;
  let rank = new Map(modules.map((x) => [x, 1 / n]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(modules.map((x) => [x, (1 - damping) / n]));
    for (const node of modules) {
      const share = (rank.get(node) ?? 0) * damping;
      const total = strength.get(node) ?? 0;
      if (total === 0) {
        for (const other of modules) next.set(other, (next.get(other) ?? 0) + share / n);
        continue;
      }
      for (const [nb, w] of adj.get(node) ?? []) {
        next.set(nb, (next.get(nb) ?? 0) + (share * w) / total);
      }
    }
    rank = next;
  }
  return rank;
}

/** Label a community by its most central members. A cluster has no name of its own. */
export function nameCluster(
  members: number[],
  edges: Edge[],
  files: string[],
  k = 5,
): string[] {
  const inside = new Set(members);
  const sub = edges.filter((e) => inside.has(e.a) && inside.has(e.b));
  const pr = pageRank(sub, members);
  return [...members]
    .sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0) || a - b)
    .slice(0, k)
    .map((id) => files[id])
    .filter((p): p is string => p !== undefined);
}

/**
 * Project file-level edges up to modules: remap endpoints to their parent
 * module, drop self-loops (intra-module churn is not a signal), sum weights.
 * The shape of wikis' `architectural_projection`, with symbol->parent replaced
 * by file->module.
 *
 * Weights are read through `edgeWeight`, exactly as `pageRank`, `louvain`,
 * `detectHubs` and `bridgeComponents` read them. Summing the raw signed `npmi`
 * instead lets an anti-correlated pair *subtract* from a module edge, so a
 * module pair can surface in the committed artifact carrying a negative or
 * exactly-zero "dependency" weight — a claim the rest of the engine, which
 * treats a non-positive nPMI as evidence of separation, does not make.
 *
 * `edges` is the *weighted* edge list (Task 3), not the *bridged* one (Task 7):
 * a synthetic bridge is a clustering aid backed by no commit (`support === 0`),
 * and rolling one up would invent an inter-module dependency out of nothing.
 */
export function rollUp(
  edges: Edge[],
  files: string[],
  moduleOf: (path: string) => string,
): ModuleEdge[] {
  const acc = new Map<string, ModuleEdge>();
  for (const e of edges) {
    const weight = edgeWeight(e);
    if (weight === 0) continue;
    const pa = files[e.a];
    const pb = files[e.b];
    if (pa === undefined || pb === undefined) continue;
    const ma = moduleOf(pa);
    const mb = moduleOf(pb);
    if (ma === mb) continue;
    const [from, to] = ma < mb ? [ma, mb] : [mb, ma];
    // NUL, not a space: module names come from real path segments, which may
    // contain spaces. A space-joined key makes ("a", "b c") and ("a b", "c")
    // collide, quietly summing two unrelated module edges into one. NUL is the
    // one byte a POSIX path cannot hold.
    const key = `${from}\u0000${to}`;
    const existing = acc.get(key);
    if (existing) existing.weight += weight;
    else acc.set(key, { from, to, weight });
  }
  // Ties break on raw code units — the same comparison that ordered the
  // endpoints above. `localeCompare` would collate by the machine's default
  // locale ("pkg/aa" sorts before "pkg/z" in en-US and after it in da-DK), so a
  // committed artifact would churn on nothing but a change of LANG.
  return [...acc.values()].sort(
    (x, y) => y.weight - x.weight || compare(x.from, y.from) || compare(x.to, y.to),
  );
}

/**
 * Order two module names, as every consumer in this package must order them.
 *
 * Raw UTF-16 code units — the same comparison `Array.prototype.sort` applies by
 * default, which is what orders `Spine.modules`. `localeCompare` must not be
 * used in its place for two independent reasons, both of which put churn into a
 * committed artifact:
 *
 *  - It collates by the machine's default locale. "pkg/aa" sorts before "pkg/z"
 *    in en-US and after it in da-DK, so the artifact changes on nothing but a
 *    change of LANG.
 *  - It disagrees with code-unit order on the *same* machine wherever case or
 *    punctuation is involved — `localeCompare` puts "alpha/x" before "Zed/x",
 *    code units put "Zed/x" first. A module list and an edge list sorted by the
 *    two different rules are inconsistent with each other in any repo holding a
 *    capitalized module directory (`Sources/`, `App/`).
 *
 * Exported so an edge list built anywhere in this package — `rollUp` from
 * commit co-change, `readGraphify` from a declared import graph — lands in one
 * order. This rule was open-coded once and diverged immediately; read it
 * through this and it cannot.
 */
export function compare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}
