---
name: graph fixture — a two-module boundary-crossing fixture needs a third, unrelated component
description: >-
  A packages/graph fixture built with only two modules joined by one
  co-change edge won't exercise Louvain's boundary-crossing detection
  (workingSets, cluster partitioning) — Louvain trivially merges two
  nodes with one edge into a single community, so the "crosses a
  boundary" signal never appears. Add an isolated background module.
type: reference
tags: [area/graph, area/testing]
created: 2026-08-10
updated: 2026-08-10
---

## The trap

A fixture built as "module `a`, module `b`, N commits co-changing one file
in each" looks like the minimal case for a cross-module working set, but
Louvain has nothing to partition: two nodes with a single edge between them
just form one trivial community, and downstream code that reports
boundary-crossing structure (`workingSets()` in `working-sets.ts`, via
`analyze()`) can legitimately come back empty even though `doctor()` grades
the repo `ok` and every threshold is cleared.

Verified 2026-08-10 (T7.2 merge-gate black-box probe): a from-scratch
throwaway git repo with `a/shared.ts` + `b/shared.ts` co-changed 16 times,
`minCommits` cleared, `doctor().status === "ok"` — `analyze().workingSets`
still `[]`. Not a product defect; the fixture never gave the partitioner a
third, independent component to distinguish "the graph has real cluster
structure and `a`/`b` are one community that spans a module boundary" from
"the graph is one edge."

## The fix

Add a separate, internally-cohesive component the cross-module pair has no
edge to — the existing test suite's own pattern (`backgroundChurn` in
`test/analyze.test.ts`) builds many small isolated co-change pairs under a
single `bg/` directory (its own module by the two-segment fallback) for
exactly this reason:

```ts
// many small isolated pairs -> real structure for Louvain to partition
for (let i = 0; i < N; i++) {
  commit(["bg/${i}a.ts", "bg/${i}b.ts"]);
  commit(["bg/${i}a.ts", "bg/${i}b.ts"]);
}
// the pattern actually under test
for (let i = 0; i < M; i++) commit(["a/shared.ts", "b/shared.ts"]);
```

With a third module present, Louvain finds real community boundaries and
the `a`/`b` cross-module working set appears as expected.

## Why existing tests never hit this

`test/analyze.test.ts`'s own fixtures (`crossModuleRepo`, the hub-placement
fixtures) all call `backgroundChurn` for this reason already — the trap only
bites a fixture built independently of that helper, e.g. a black-box probe
against the built `dist/` that doesn't reuse `test/fixtures/`.

Related: [[graph-fixture-map-output-must-be-gitignored-before-a-second-run]]
· [[graph-ci-checkout-is-shallow-live-history-tests-return-empty]] — same
flavor of "passes until the fixture is shaped like the real thing."
