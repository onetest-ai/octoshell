import type { Edge } from "./weights.js";

export interface LouvainOptions {
  /** Nodes to leave out of clustering (hubs). */
  exclude?: Set<number>;
  /** Resolution gamma. Defaults to autoResolution(nodeCount). */
  resolution?: number;
  maxPasses?: number;
}

/**
 * Resolution by graph size. Verbatim from wikis'
 * `graph_clustering.auto_resolution`: lower gamma yields fewer, larger
 * communities, and the constant is tuned so typical repos land in a sane range.
 */
export function autoResolution(nodeCount: number): number {
  if (nodeCount < 2) return 1.0;
  return Math.max(0.3, 1.0 - 0.2 * Math.log10(nodeCount));
}

/**
 * Louvain modularity maximisation over the weighted undirected graph.
 *
 * Deterministic: nodes are visited in ascending id order and ties are broken
 * toward the lower community id, so no seed or RNG is involved. That matters
 * because the output is a committed artifact — see stability.ts.
 */
export function louvain(edges: Edge[], opts: LouvainOptions = {}): Map<number, number> {
  const exclude = opts.exclude ?? new Set<number>();
  const kept = edges.filter((e) => !exclude.has(e.a) && !exclude.has(e.b));

  const nodes = [...new Set(kept.flatMap((e) => [e.a, e.b]))].sort((a, b) => a - b);
  const community = new Map<number, number>();
  nodes.forEach((n) => community.set(n, n));
  if (nodes.length === 0) return community;

  const gamma = opts.resolution ?? autoResolution(nodes.length);
  const maxPasses = opts.maxPasses ?? 20;

  // Adjacency with positive weights only: a negative nPMI means the pair
  // co-occurs less than chance, which is evidence of separation, not a link.
  const adj = new Map<number, Map<number, number>>();
  const strength = new Map<number, number>();
  let totalWeight = 0;
  for (const e of kept) {
    const w = Math.max(0, e.npmi);
    if (w === 0) continue;
    for (const [u, v] of [[e.a, e.b], [e.b, e.a]] as const) {
      let row = adj.get(u);
      if (!row) adj.set(u, (row = new Map()));
      row.set(v, (row.get(v) ?? 0) + w);
      strength.set(u, (strength.get(u) ?? 0) + w);
    }
    totalWeight += w;
  }
  if (totalWeight === 0) return community;
  const m2 = 2 * totalWeight;

  const commStrength = new Map<number, number>();
  for (const n of nodes) commStrength.set(n, strength.get(n) ?? 0);

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const n of nodes) {
      const own = community.get(n);
      if (own === undefined) continue;
      const kn = strength.get(n) ?? 0;

      // Weight from n into each neighbouring community.
      const into = new Map<number, number>();
      for (const [nb, w] of adj.get(n) ?? []) {
        const c = community.get(nb);
        if (c === undefined || nb === n) continue;
        into.set(c, (into.get(c) ?? 0) + w);
      }

      commStrength.set(own, (commStrength.get(own) ?? 0) - kn);
      let best = own;
      let bestGain = (into.get(own) ?? 0) - (gamma * kn * (commStrength.get(own) ?? 0)) / m2;

      for (const [c, wIn] of into) {
        if (c === own) continue;
        const gain = wIn - (gamma * kn * (commStrength.get(c) ?? 0)) / m2;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
          best = c;
          bestGain = gain;
        }
      }

      commStrength.set(best, (commStrength.get(best) ?? 0) + kn);
      if (best !== own) {
        community.set(n, best);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return community;
}
