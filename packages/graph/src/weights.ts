import type { PairTable } from "./cochange.js";

export interface WeightOptions {
  /** Pairs seen fewer times than this are noise. */
  minSupport?: number;
}

export interface Edge {
  a: number;
  b: number;
  /** Raw number of commits touching both files — the undecayed unit
   *  `minSupport` filters on, kept as a human-readable "how often". */
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
 *
 * The probabilities are measured in *decayed commit mass* (`PairStat.weight`
 * over `PairTable.weightTotal`), not in raw commit counts. Both must come from
 * the same unit: dividing a decayed numerator by an undecayed denominator
 * cancels the decay out of every edge, which silently turns `halfLifeDays`
 * into a no-op and makes a two-year-old pairing score identically to one from
 * last week. `support` stays a raw count because `minSupport` is a
 * "seen at least N times" filter, not a strength.
 */
export function weighEdges(table: PairTable, opts: WeightOptions = {}): Edge[] {
  const minSupport = opts.minSupport ?? 2;
  const out: Edge[] = [];
  const total = table.weightTotal;
  // No commits, or a history so old its entire mass underflowed to zero.
  if (table.commitCount === 0 || !(total > 0)) return out;

  for (const [i, row] of table.pairs) {
    for (const [j, stat] of row) {
      if (stat.support < minSupport) continue;
      const wi = table.singleWeight[i];
      const wj = table.singleWeight[j];
      if (wi === undefined || wj === undefined) continue;

      const pab = stat.weight / total;
      const pa = wi / total;
      const pb = wj / total;
      // A pair whose whole history has decayed to zero mass carries no
      // evidence. Left alone, log(0) makes npmi NaN, and NaN both lands in the
      // committed artifact and makes the sort comparator below return NaN —
      // an unspecified, run-to-run-unstable order for every other edge.
      if (!(pab > 0) || !(pa > 0) || !(pb > 0)) continue;

      const pmi = Math.log(pab / (pa * pb));
      // -log(pab) is 0 only when pab === 1, i.e. the pair carries the entire
      // decayed mass of the history. `weight` and `weightTotal` accumulate the
      // same decay factors in the same order in that case, so this is an exact
      // float equality, not an epsilon comparison.
      const denom = -Math.log(pab);
      const npmi = denom === 0 ? 1 : clamp(pmi / denom, -1, 1);

      out.push({
        a: i,
        b: j,
        support: stat.support,
        npmi,
        confidence: clamp(Math.min(stat.weight / wi, stat.weight / wj), 0, 1),
      });
    }
  }

  // Deterministic order: strongest first, ties broken by file id.
  out.sort((x, y) => y.npmi - x.npmi || x.a - y.a || x.b - y.b);
  return out;
}

/** nPMI and confidence are mathematically bounded; float division can land a
 *  ulp outside, and the bound is part of these fields' published contract. */
function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
