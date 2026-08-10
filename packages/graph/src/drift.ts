import { classifyPair } from "./noise.js";
import { compare } from "./rollup.js";
import { edgeWeight, type Edge } from "./weights.js";
import type { Spine } from "./spine.js";

export interface DriftRow {
  a: string;
  b: string;
  moduleA: string;
  moduleB: string;
  npmi: number;
  support: number;
  confidence: number;
}

/** Separator for a declared-pair set key. Arbitrary but must not itself be
 *  producible by joining two module names some other way. "->" never occurs
 *  inside a path or a Graphify-declared module name. */
const PAIR_SEP = "->";

/**
 * Coupling the declared structure does not explain.
 *
 * **This is the command the whole design exists for.** An unfiltered ranking
 * by raw co-change is topped entirely by couplings the user already knows —
 * test-subject, then manifest-lockfile, then intra-module siblings — so the
 * noise floor (`classifyPair`) is mandatory, not a refinement: without it the
 * real finding is buried under the obvious ones.
 *
 * A run whose top result is a manifest and its lockfile has failed, however
 * high the nPMI — hence the noise floor. With a Graphify spine, "nothing
 * imports across them" is a real claim; with only manifests it weakens to
 * "different declared modules", so precision degrades but availability does
 * not.
 *
 * Weight is read through `edgeWeight`, never `Edge.npmi` directly (see
 * weights.ts and this package's `conventions.test.ts`), so a
 * negatively-correlated pair — evidence of separation, not of coupling —
 * never ranks as drift. Ties are broken through `compare` (rollup.ts), never
 * `localeCompare`, so the ordering is stable across machines and locales.
 */
export function drift(edges: Edge[], files: string[], spine: Spine, limit = 20): DriftRow[] {
  const declared = new Set<string>();
  for (const e of spine.imports) {
    declared.add(`${e.from}${PAIR_SEP}${e.to}`);
    declared.add(`${e.to}${PAIR_SEP}${e.from}`);
  }

  const scored: Array<{ row: DriftRow; weight: number }> = [];
  for (const e of edges) {
    if (e.support === 0) continue; // synthetic bridge, not evidence
    const weight = edgeWeight(e);
    if (weight <= 0) continue;

    const pa = files[e.a];
    const pb = files[e.b];
    if (pa === undefined || pb === undefined) continue;
    if (classifyPair(pa, pb) !== "candidate") continue;

    const ma = spine.moduleOf(pa);
    const mb = spine.moduleOf(pb);
    if (ma === mb) continue; // intra-module
    if (declared.has(`${ma}${PAIR_SEP}${mb}`)) continue; // already declared

    scored.push({
      row: {
        a: pa,
        b: pb,
        moduleA: ma,
        moduleB: mb,
        npmi: weight,
        support: e.support,
        confidence: e.confidence,
      },
      weight,
    });
  }

  scored.sort(
    (x, y) => y.weight - x.weight || compare(x.row.a, y.row.a) || compare(x.row.b, y.row.b),
  );
  return scored.slice(0, limit).map((s) => s.row);
}
