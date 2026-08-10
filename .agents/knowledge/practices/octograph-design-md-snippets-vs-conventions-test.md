---
name: octograph design.md task snippets can violate packages/graph's own convention guard
description: packages/graph/test/conventions.test.ts source-scans src/ and bans `.npmi` property access outside weights.ts and `localeCompare` anywhere — several M2 design.md task snippets predate that guard and would fail it if copied verbatim.
type: reference
applies_to: [js-dev, tech-lead, qa-engineer]
verified: 2026-08-09
aliases: [conventions.test.ts, edgeWeight guard, npmi lint guard, design.md snippet drift]
tags: [area/testing, area/graph]
---

## The fact

`packages/graph/test/conventions.test.ts` (added during the M2 spine/map work, after several
`design.md` task sections were already written and tech-lead-reviewed) source-scans every file in
`packages/graph/src/` (comments/strings stripped) and fails the build if:

- any file other than `weights.ts` contains a literal `.npmi` property access — i.e. every
  consumer of an `Edge`'s weight must go through `edgeWeight(e)`, never `e.npmi` directly, even to
  read it for display/reporting rather than for graph math;
- any file contains `localeCompare(` — string ordering must go through `compare()` (exported from
  `rollup.ts`), because `localeCompare` collates by machine locale and produces a committed
  artifact that churns on nothing but a `LANG` change.

`.octobots/campaigns/octograph-code-architecture-graph/missions/m2-declared-spine-map-and-impact/design.md`'s
own literal task snippets were written before this guard existed and don't all honor it — e.g.
Task 12's `impact()` snippet sorts/reports raw `e.npmi` and tie-breaks with
`x.path.localeCompare(y.path)`. Copying such a snippet verbatim compiles and typechecks, and even
passes the task's own listed acceptance tests (because the fixtures only use positive nPMI values,
where `e.npmi === edgeWeight(e)`), but fails `pnpm --filter @octoshell/graph lint` /
`conventions.test.ts`.

## Why it matters / what it costs to get wrong

- **`js-dev`** picking up any remaining/future M2 or M3 octograph task: don't trust a design.md
  snippet to be lint-clean just because it's "tech-lead reviewed" — that review predates this
  guard for sections written early in the mission. Route any edge-weight read through
  `edgeWeight()` and any string ordering through `rollup.ts`'s `compare()`, even where the design
  doc's own code sample does it differently. The substitution is usually numerically
  behavior-identical for the given test fixtures, so it doesn't fight the acceptance criteria — it
  just makes `pnpm lint` pass too.
- **`tech-lead`** reviewing a PR against this mission: a diff that reads `e.npmi` or calls
  `.localeCompare()` anywhere in `packages/graph/src/*.ts` (outside `weights.ts`) is a guaranteed
  `conventions.test.ts` failure, not a style nit — check for it before approving even if the PR
  claims "implemented verbatim per design.md".
- **`qa-engineer`**: if `pnpm --filter @octoshell/graph test`/`lint` are green, this guard already
  passed — no extra manual check needed beyond confirming those two commands were actually run
  (not skipped because "matches the spec").

## How this was verified

2026-08-09, T2.4 (`impact()` in `packages/graph/src/impact.ts`) — read
`packages/graph/test/conventions.test.ts` directly (bans `/\.npmi\b/` outside `weights.ts`,
`/\blocaleCompare\s*\(/` anywhere). Confirmed design.md's Task 12 snippet contains both patterns.
Implemented `impact()` routing through `edgeWeight()` and `rollup.ts`'s `compare()` instead; ran
`pnpm --filter @octoshell/graph test` (132/132 green, including `conventions.test.ts`'s 4 tests)
and `pnpm --filter @octoshell/graph lint` (clean). PR #39.

Related: [[dist-before-typecheck]] — a different repo-wide "the obvious command isn't the safe
one" hazard in the same spirit: don't assume a design artifact or a per-package command reflects
the current, full state of the rules.
