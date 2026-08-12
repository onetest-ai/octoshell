import { isSyntheticBridge } from "./components.js";
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

/**
 * The declared module pairs, as a lookup with NO composite key at all.
 *
 * A module name is a repo-relative path fragment, so it can legally hold any
 * byte a POSIX path can hold — which is every byte except NUL. Joining two of
 * them into one string therefore has no safe separator short of NUL itself
 * (the choice `rollUp` makes, and documents, for its accumulator key): any
 * printable separator can appear inside a name, and the moment it does, two
 * different pairs collide on one key. With "->" as the separator, a declared
 * edge `a -> b->c` produced the key `a->b->c`, which is also what the pair
 * (`a->b`, `c`) produces — so a real drift finding between `a->b` and `c` was
 * silently suppressed as "already declared".
 *
 * Nesting the sets removes the question instead of answering it: the two names
 * never meet in one string, so no separator has to be safe. Membership is only
 * ever TESTED here, never iterated, so no `Map`/`Set` ordering reaches output.
 */
function declaredPairs(imports: Spine["imports"]): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>();
  const relate = (from: string, to: string): void => {
    const peers = byModule.get(from);
    if (peers) peers.add(to);
    else byModule.set(from, new Set([to]));
  };
  for (const e of imports) {
    relate(e.from, e.to);
    relate(e.to, e.from);
  }
  return byModule;
}

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
 * `localeCompare`, so the ordering is stable across machines and locales — and
 * each row's own two endpoints are ordered by the same `compare` before the
 * tie-break reads them, so neither the row nor the ranking inherits the
 * git-log-dependent order of `Edge.a`/`Edge.b` (see the loop below).
 *
 * `limit` is a count of rows to KEEP, so it is floored at zero rather than
 * handed to `slice` raw. `slice(0, -1)` does not mean "no limit" and does not
 * mean "nothing" — it drops the last row and returns the rest, i.e. it hides
 * the weakest finding and reports the others as if the list were complete.
 * This is a public export (index.ts) that a CLI `--limit` will feed, and "-1
 * means unlimited" is a common enough CLI convention that the value will
 * arrive eventually.
 */
export function drift(edges: Edge[], files: string[], spine: Spine, limit = 20): DriftRow[] {
  const declared = declaredPairs(spine.imports);
  const keep = limit > 0 ? limit : 0;

  const scored: Array<{ row: DriftRow; weight: number }> = [];
  for (const e of edges) {
    if (isSyntheticBridge(e)) continue; // no commit backs it — see components.ts
    const weight = edgeWeight(e);
    if (weight <= 0) continue;

    const left = files[e.a];
    const right = files[e.b];
    if (left === undefined || right === undefined) continue;
    // Canonical endpoint orientation, exactly as `rollUp` orders a module
    // edge's endpoints before keying it. A co-change pair is UNDIRECTED, but
    // `Edge.a`/`Edge.b` are file IDS, and an id is assigned by first appearance
    // in `git log` output — newest commit first. So which of the two paths
    // lands in `DriftRow.a` is decided by which file some unrelated later
    // commit happened to touch most recently: commit anything that mentions
    // only `svc/b/api.ts` and this row silently flips to `api.ts <-> client.ts`
    // on the next run, and the equal-weight tie-break below re-sorts with it.
    // Both orientations state the same true fact, which is precisely why the
    // churn is invisible in review and lands in a committed artifact anyway.
    const swapped = compare(left, right) > 0;
    const pa = swapped ? right : left;
    const pb = swapped ? left : right;
    if (classifyPair(pa, pb) !== "candidate") continue;

    const ma = spine.moduleOf(pa);
    const mb = spine.moduleOf(pb);
    if (ma === mb) continue; // intra-module
    if (declared.get(ma)?.has(mb) === true) continue; // already declared

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
  return scored.slice(0, keep).map((s) => s.row);
}
