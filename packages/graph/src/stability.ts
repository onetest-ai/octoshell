export interface RemapOptions {
  /** Minimum overlap for a new cluster to inherit an old id. */
  threshold?: number;
}

/**
 * |A ∩ B| / |A ∪ B|. Two empty sets are 0, not NaN.
 *
 * 0 is the arithmetic answer to "how much of the union is shared" when there is
 * no union — it is deliberately NOT a claim that two memberless clusters are
 * different clusters. That is a remap POLICY question and it is answered in
 * `remapClusters` (see `overlap` there), which never asks this function about a
 * pair it has already decided.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * How much of `newSet` and `oldSet` is shared, for the purpose of inheriting an
 * id — Jaccard, except that two MEMBERLESS clusters count as a full match.
 *
 * `analyze()` really does produce memberless clusters, and not rarely: a module
 * that Graphify declares (so it is a real `moduleEdges` endpoint and gets its
 * own heading) but whose files no analysable commit touched inside the harvest
 * window has `members: []` — see the "Graphify names a module the harvest
 * window never touched" case in analyze.ts/spine.ts. Scored by raw Jaccard,
 * such a cluster overlaps its own previous self by 0, falls under any
 * threshold, and mints a fresh id ON EVERY RUN — the id climbs 2, 3, 4, … while
 * nothing whatsoever changed in the repo. That is precisely the committed-
 * artifact churn this module exists to prevent, and it also makes the caller's
 * `kept`/`fresh` tally report a fresh cluster on a run that had none.
 *
 * Two memberless clusters are byte-identical in `clusters.json` (`[]` under an
 * id, no name anywhere), so which of several a given id lands on is not
 * observable in the artifact and cannot mis-state anything in it; what IS
 * observable is the id churning every run. Pairing them is therefore strictly
 * more honest than re-minting, and the greedy pass below keeps the pairing
 * deterministic (score, then ascending new id, then ascending old id).
 */
function overlap(newSet: Set<string>, oldSet: Set<string>): number {
  if (newSet.size === 0 && oldSet.size === 0) return 1;
  return jaccard(newSet, oldSet);
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
 * unrelated clusters, higher breaks ids on minor churn. Overlap is scored
 * through `overlap` above, not `jaccard` directly — see its comment for the
 * one pair Jaccard alone answers wrongly here.
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
      const score = overlap(set, oldSet);
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
