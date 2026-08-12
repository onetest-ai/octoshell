import { rankScore } from "./rank.js";
import { compare } from "./rollup.js";
import { edgeWeight, type Edge } from "./weights.js";

export interface ImpactRow {
  path: string;
  npmi: number;
  support: number;
  confidence: number;
}

/**
 * What else moves when this file changes.
 *
 * Ranked by nPMI, not raw overlap: every file "co-changes" with the lockfile,
 * and raw counts would surface exactly that. Weight is read through
 * `edgeWeight`, so a negatively-correlated pair — evidence of separation, not
 * of coupling — never shows up as "impact".
 *
 * The SORT key is `rankScore` (rank.ts), the same shrinkage `drift` uses —
 * this is the same human-facing ranked list with the same failure mode:
 * nPMI alone lets a pair seen only `minSupport` times outrank one with far
 * more repeated evidence. `ImpactRow.npmi` still reports the plain
 * `edgeWeight` value; only the order changes.
 */
export function impact(
  path: string,
  edges: Edge[],
  files: string[],
  limit = 20,
  minSupport = 2,
): ImpactRow[] {
  const id = files.indexOf(path);
  if (id === -1) return [];

  const scored: Array<{ row: ImpactRow; score: number }> = [];
  for (const e of edges) {
    const other = e.a === id ? e.b : e.b === id ? e.a : -1;
    if (other === -1) continue;
    const weight = edgeWeight(e);
    if (weight <= 0) continue;
    const p = files[other];
    if (p === undefined) continue;
    scored.push({
      row: { path: p, npmi: weight, support: e.support, confidence: e.confidence },
      score: rankScore(weight, e.support, minSupport),
    });
  }

  scored.sort((x, y) => y.score - x.score || compare(x.row.path, y.row.path));
  return scored.slice(0, limit).map((s) => s.row);
}
