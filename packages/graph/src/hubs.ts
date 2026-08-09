import { edgeWeight, type Edge } from "./weights.js";

export interface HubOptions {
  /** Standard deviations above mean strength before a node is a hub. */
  zThreshold?: number;
}

/**
 * Find nodes that bridge unrelated parts of the graph.
 *
 * Adapted from wikis' `graph_topology.detect_hubs`, which measures IN-DEGREE
 * because its AST graph is directed. Co-occurrence has no direction, so
 * in-degree is undefined here — weighted degree (strength) is the analogue.
 *
 * nPMI already suppresses hub *weight*; quarantine is still needed because a
 * hub *bridges* communities and distorts partitioning even at low weight.
 */
export function detectHubs(
  edges: Edge[],
  fileCount: number,
  opts: HubOptions = {},
): Set<number> {
  const z = opts.zThreshold ?? 3;
  const hubs = new Set<number>();
  if (fileCount < 3) return hubs;

  const strength = new Array<number>(fileCount).fill(0);
  for (const e of edges) {
    // Negative nPMI means "these two co-change less than chance would predict"
    // — evidence of no coupling, not of anti-coupling. Summed signed, it would
    // *subtract* from a node's degree: a high-churn file scores negative
    // against the other high-churn files it seldom moves with, so the very
    // nodes quarantine exists to catch could cancel themselves back under the
    // threshold. Clamping at 0 also makes this the same graph the clustering
    // downstream measures, which reads weights through the same `edgeWeight` —
    // a hub detector reading a different graph quarantines the wrong nodes.
    const w = edgeWeight(e);
    strength[e.a] = (strength[e.a] ?? 0) + w;
    strength[e.b] = (strength[e.b] ?? 0) + w;
  }

  const mean = strength.reduce((a, b) => a + b, 0) / fileCount;
  const variance =
    strength.reduce((acc, s) => acc + (s - mean) ** 2, 0) / fileCount;
  const sd = Math.sqrt(variance);
  if (sd === 0) return hubs;

  strength.forEach((s, i) => {
    if ((s - mean) / sd > z) hubs.add(i);
  });
  return hubs;
}
