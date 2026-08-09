import type { Edge } from "./weights.js";

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
    strength[e.a] = (strength[e.a] ?? 0) + e.npmi;
    strength[e.b] = (strength[e.b] ?? 0) + e.npmi;
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
