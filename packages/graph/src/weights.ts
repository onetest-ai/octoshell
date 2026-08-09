import type { PairTable } from "./cochange.js";

export interface WeightOptions {
  /** Pairs seen fewer times than this are noise. */
  minSupport?: number;
}

export interface Edge {
  a: number;
  b: number;
  support: number;
  /** Normalized pointwise mutual information, in [-1, 1]. */
  npmi: number;
  /** min(P(a|b), P(b|a)) — how much of the rarer file's history is shared. */
  confidence: number;
}

/**
 * Weight pairs by normalized PMI.
 *
 * Raw counts are useless here: a lockfile co-changes with everything, so
 * frequency alone ranks mechanical noise above real coupling. PMI divides out
 * each file's own churn; normalizing bounds the result to [-1, 1] so a single
 * threshold means the same thing in a small repo and a large one.
 */
export function weighEdges(table: PairTable, opts: WeightOptions = {}): Edge[] {
  const minSupport = opts.minSupport ?? 2;
  const n = table.commitCount;
  const out: Edge[] = [];
  if (n === 0) return out;

  for (const [i, row] of table.pairs) {
    for (const [j, stat] of row) {
      if (stat.support < minSupport) continue;
      const ci = table.single[i];
      const cj = table.single[j];
      if (ci === undefined || cj === undefined) continue;

      const pab = stat.support / n;
      const pmi = Math.log(pab / ((ci / n) * (cj / n)));
      // -log(pab) is 0 only when pab === 1, i.e. the pair is in every commit.
      const denom = -Math.log(pab);
      const npmi = denom === 0 ? 1 : pmi / denom;

      out.push({
        a: i,
        b: j,
        support: stat.support,
        npmi,
        confidence: Math.min(stat.support / ci, stat.support / cj),
      });
    }
  }

  // Deterministic order: strongest first, ties broken by file id.
  out.sort((x, y) => y.npmi - x.npmi || x.a - y.a || x.b - y.b);
  return out;
}
