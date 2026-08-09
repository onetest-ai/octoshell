import type { Commit } from "./types.js";

export interface DecayOptions {
  /** Reference "now" in epoch ms. Passed in rather than read from the clock so
   *  the same commit always produces the same graph. */
  now: number;
  /** Days after which a commit's contribution halves. */
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
  /** i -> j -> stat, always i < j. */
  pairs: Map<number, Map<number, PairStat>>;
  commitCount: number;
}

export function countPairs(commits: Commit[], opts: DecayOptions): PairTable {
  const halfLife = opts.halfLifeDays ?? 180;
  const lambda = Math.LN2 / (halfLife * 86400000);

  const ids = new Map<string, number>();
  const files: string[] = [];
  const single: number[] = [];
  const pairs = new Map<number, Map<number, PairStat>>();

  const idOf = (path: string): number => {
    let id = ids.get(path);
    if (id === undefined) {
      id = files.length;
      ids.set(path, id);
      files.push(path);
      single.push(0);
    }
    return id;
  };

  for (const c of commits) {
    const age = Math.max(0, opts.now - c.timestamp);
    const decay = Math.exp(-lambda * age);
    const list = [...new Set(c.files.map(idOf))].sort((a, b) => a - b);

    for (const i of list) single[i] = (single[i] ?? 0) + 1;

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

  return { files, single, pairs, commitCount: commits.length };
}
