import type { Edge } from "./weights.js";

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
    const w = Math.max(0, e.npmi);
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
 */
export function rollUp(
  edges: Edge[],
  files: string[],
  moduleOf: (path: string) => string,
): ModuleEdge[] {
  const acc = new Map<string, ModuleEdge>();
  for (const e of edges) {
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
    if (existing) existing.weight += e.npmi;
    else acc.set(key, { from, to, weight: e.npmi });
  }
  // Ties break on raw code units — the same comparison that ordered the
  // endpoints above. `localeCompare` would collate by the machine's default
  // locale ("pkg/aa" sorts before "pkg/z" in en-US and after it in da-DK), so a
  // committed artifact would churn on nothing but a change of LANG.
  return [...acc.values()].sort(
    (x, y) => y.weight - x.weight || compare(x.from, y.from) || compare(x.to, y.to),
  );
}

function compare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}
