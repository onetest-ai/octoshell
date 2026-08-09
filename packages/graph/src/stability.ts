export interface RemapOptions {
  /** Minimum overlap for a new cluster to inherit an old id. */
  threshold?: number;
}

/** |A ∩ B| / |A ∪ B|. Two empty sets are 0, not NaN — callers never ask. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pin fresh cluster ids onto the previous run's ids.
 *
 * Louvain is deterministic given the same graph, but the ids it assigns are
 * arbitrary — insertion order. The same logical module can come back labelled 7
 * instead of 3, which would rewrite most of map.md on a run where nothing
 * changed. Since the previous run is a committed artifact, the "old clusters"
 * input is simply read back from it: the artifact makes its own stability
 * computable, with no state store.
 *
 * Ported from wikis' `cluster_stability.compute_jaccard_remap`. The 0.5
 * threshold requires more than half the union preserved: lower matches
 * unrelated clusters, higher breaks ids on minor churn.
 */
export function remapClusters(
  oldClusters: Map<number, string[]>,
  newClusters: Map<number, string[]>,
  opts: RemapOptions = {},
): Map<number, number> {
  const threshold = opts.threshold ?? 0.5;
  const oldSets = new Map<number, Set<string>>();
  for (const [id, members] of oldClusters) oldSets.set(id, new Set(members));

  let nextId = oldClusters.size === 0 ? 0 : Math.max(...oldClusters.keys()) + 1;
  const claimed = new Set<number>();
  const remap = new Map<number, number>();

  // Score every (new, old) candidate, then assign greedily best-first so the
  // strongest match wins an id rather than whichever iterated first.
  const candidates: Array<{ newId: number; oldId: number; score: number }> = [];
  for (const [newId, members] of newClusters) {
    const set = new Set(members);
    for (const [oldId, oldSet] of oldSets) {
      const score = jaccard(set, oldSet);
      if (score >= threshold) candidates.push({ newId, oldId, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.newId - y.newId || x.oldId - y.oldId);

  const assigned = new Map<number, number>();
  for (const { newId, oldId } of candidates) {
    if (assigned.has(newId) || claimed.has(oldId)) continue;
    assigned.set(newId, oldId);
    claimed.add(oldId);
  }

  const newIds = [...newClusters.keys()].sort((a, b) => a - b);
  for (const newId of newIds) {
    if (!assigned.has(newId)) assigned.set(newId, nextId++);
  }

  // Emit in ascending new-cluster order, not in the order the greedy pass
  // happened to claim ids. `assigned`'s own order tracks Jaccard score, so a
  // consumer iterating it writes the artifact in an order that reshuffles
  // whenever any cluster's overlap shifts — churn indistinguishable from real
  // change in a diff. `louvain` and `detectHubs` both pin ascending iteration
  // order for the same reason; this is the third module in that contract.
  for (const newId of newIds) {
    const stable = assigned.get(newId);
    if (stable !== undefined) remap.set(newId, stable);
  }
  return remap;
}
