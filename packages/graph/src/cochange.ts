import type { Commit } from "./types.js";

const MS_PER_DAY = 86400000;

export interface DecayOptions {
  /** Reference "now" in epoch ms. Passed in rather than read from the clock so
   *  the same commit always produces the same graph. */
  now: number;
  /** Days after which a commit's contribution halves. Must be finite and > 0. */
  halfLifeDays?: number;
}

export interface PairStat {
  /** Number of commits touching both files. */
  support: number;
  /** Sum of per-commit decay factors. */
  weight: number;
}

export interface PairTable {
  /** Interned paths; every id below indexes this array. */
  files: string[];
  /** single[i] = number of commits touching file i. */
  single: number[];
  /**
   * singleWeight[i] = sum of the decay factors of the commits touching file i.
   *
   * The decayed counterpart of `single`, and the denominator a decayed
   * `PairStat.weight` needs: mixing a decayed numerator with an undecayed
   * denominator compares two different units and silently discards the decay.
   * Same relationship as `weightTotal` : `commitCount`.
   */
  singleWeight: number[];
  /** i -> j -> stat, always i < j. */
  pairs: Map<number, Map<number, PairStat>>;
  commitCount: number;
  /** Sum of the decay factors of every commit — the decayed `commitCount`. */
  weightTotal: number;
}

export function countPairs(commits: Commit[], opts: DecayOptions): PairTable {
  const halfLife = opts.halfLifeDays ?? 180;
  // A non-positive or non-finite half-life does not fail loudly on its own:
  // halfLife === 0 makes lambda Infinity, and Infinity * 0 (a same-day commit)
  // is NaN, so every weight in the table silently becomes NaN. A negative one
  // is worse — it inverts the decay, so 2024 outranks last month. Both would
  // reach a committed artifact looking like a real graph.
  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    throw new RangeError(
      `halfLifeDays must be a finite number greater than 0, got ${String(opts.halfLifeDays)}`,
    );
  }
  if (!Number.isFinite(opts.now)) {
    throw new RangeError(`now must be a finite epoch-ms timestamp, got ${String(opts.now)}`);
  }
  const lambda = Math.LN2 / (halfLife * MS_PER_DAY);

  const ids = new Map<string, number>();
  const files: string[] = [];
  const single: number[] = [];
  const singleWeight: number[] = [];
  const pairs = new Map<number, Map<number, PairStat>>();
  let weightTotal = 0;

  const idOf = (path: string): number => {
    let id = ids.get(path);
    if (id === undefined) {
      id = files.length;
      ids.set(path, id);
      files.push(path);
      single.push(0);
      singleWeight.push(0);
    }
    return id;
  };

  for (const c of commits) {
    // One unparseable timestamp would otherwise turn its every pair's weight
    // into NaN, and NaN loses every downstream comparison — those edges drop
    // out of the graph without a word rather than showing up as an error.
    if (!Number.isFinite(c.timestamp)) {
      throw new RangeError(
        `commit ${c.sha} has a non-finite timestamp: ${String(c.timestamp)}`,
      );
    }
    const age = Math.max(0, opts.now - c.timestamp);
    const decay = Math.exp(-lambda * age);
    weightTotal += decay;
    const list = [...new Set(c.files.map((p) => idOf(p)))].sort((a, b) => a - b);

    for (const i of list) {
      single[i] = (single[i] ?? 0) + 1;
      singleWeight[i] = (singleWeight[i] ?? 0) + decay;
    }

    for (let x = 0; x < list.length; x++) {
      const i = list[x];
      if (i === undefined) continue;
      let row = pairs.get(i);
      if (!row) pairs.set(i, (row = new Map()));
      for (let y = x + 1; y < list.length; y++) {
        const j = list[y];
        if (j === undefined) continue;
        const stat = row.get(j);
        if (stat) {
          stat.support += 1;
          stat.weight += decay;
        } else {
          row.set(j, { support: 1, weight: decay });
        }
      }
    }
  }

  return { files, single, singleWeight, pairs, commitCount: commits.length, weightTotal };
}
