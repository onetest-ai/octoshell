/**
 * Support-weighted ranking score for a coupling list a human reads top to
 * bottom — `drift` and `impact`. Nothing here reaches clustering, hub
 * quarantine, component bridging, module edges or working sets: those 14
 * consumers read `edgeWeight` directly (see weights.ts) and `rankScore`
 * changes none of them. This is a REPORTING-SURFACE fix only.
 *
 * ## The defect this exists to fix
 *
 * `edgeWeight`'s nPMI is bounded to [-1, 1] and SATURATES near 1 for any
 * pair whose entire shared history co-occurs — which a pair observed
 * exactly `minSupport` times does trivially, because nPMI measures how
 * CONSISTENT the co-occurrence was, never how MUCH evidence backed it.
 * `weighEdges` decides "is there enough evidence to admit this pair at all"
 * once, at `minSupport`, and never revisits that question — so a pair seen
 * twice and a pair seen nine times compete for rank on nPMI alone, and the
 * twice-seen coincidence usually wins.
 *
 * Measured on octoweb (1,784 commits, the campaign's own founding fixture —
 * see `.octobots/campaigns/octograph-code-architecture-graph/bugs/
 * drift-ranks-a-pair-seen-twice-above-a-pair-seen-ni/`): the pair with the
 * single HIGHEST support in the entire `drift` result (9) ranked 18th of 20,
 * behind seven pairs seen exactly twice. Raising `minSupport` does not fix
 * this — it is an admission floor, not a ranking, and every pair above it
 * still competes on raw nPMI once admitted.
 *
 * ## The fix
 *
 * Scale nPMI toward zero by `support / (support + k)` — a Bayesian/
 * "IMDB-style" shrinkage estimator, the standard fix for exactly this
 * failure in association-rule ranking. The factor is 0 at no evidence and
 * approaches 1 as evidence accumulates, so two pairs with equal nPMI are
 * ranked by support, and a pair with materially more support can outrank
 * one with slightly higher nPMI but far less evidence behind it.
 *
 * `k` is pinned to `minSupport` rather than a second, independently-tuned
 * constant: `minSupport` is ALREADY the pinned, documented floor for "how
 * much evidence is enough to admit a pair at all" (config.ts), so reusing
 * it here means a pair sitting exactly at that floor is discounted to HALF
 * its raw nPMI, fading toward no discount as support grows past the floor:
 *
 *     support === minSupport        -> factor 0.5
 *     support === 2 * minSupport    -> factor 0.667
 *     support === 4 * minSupport    -> factor 0.8
 *     support >> minSupport         -> factor -> 1
 *
 * A swept range of `k` from 0.05 to 1000 against octoweb's real `drift`
 * output shows the fix is not sensitive to the exact constant: every `k`
 * from ~0.2 upward already lifts the support-9 pair into the top 10, and
 * `k === minSupport` (2) lifts it all the way to rank 1 while leaving
 * octoshell's own `entity-io.mjs` <-> `entity-schema.ts` pair (support 2,
 * at the floor) exactly where it already ranked among its support-2/3
 * peers — reusing `minSupport` costs nothing over a freestanding constant
 * and needs no second rationale. See `test/rank.test.ts` for the pinned
 * octoweb-shaped case and the general shrinkage properties above.
 *
 * Takes the already-floored `weight` (an `edgeWeight(edge)` result), never
 * a raw `Edge.npmi` — callers already read weight through `edgeWeight`, so
 * this never becomes a second place a negative or unfloored nPMI can reach
 * a ranking.
 */
export function rankScore(weight: number, support: number, minSupport: number): number {
  return weight * (support / (support + minSupport));
}
