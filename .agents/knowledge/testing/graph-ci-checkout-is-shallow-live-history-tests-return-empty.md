---
name: graph package CI checkout is shallow — live-history tests silently return empty
description: >-
  Any packages/graph test that calls analyze()/harvest() against REPO_ROOT's
  real git log sees only 1 commit on CI (actions/checkout@v4 default
  fetch-depth), not this repo's full history — reproduced independently, not
  inferred from CI logs alone.
type: testing
verified: 2026-08-10
method: >-
  gh pr checks 52 showed both CI `build` jobs red on
  feat/octograph-code-architecture-graph-m7-t1 (PR #52) while
  `pnpm --filter @octoshell/graph test` was 338/338 green in the normal
  (full-history) working tree. Root-caused via CI log (`gh run view --log-failed`):
  packages/graph/test/working-sets.test.ts's two live-history tests
  ("finds the dual-schema working set on this repo's own history",
  "is reachable from index.ts...") failed with
  `analysis.workingSets.length === 0` on CI only. Independently reproduced
  (not just read about) by force-shallow-cloning this repo —
  `git clone --depth 1 file:///Users/arozumenko/Development/octoshell <dir>`
  (a same-machine `git clone` WITHOUT `file://` silently ignores `--depth` and
  gives full history — you must use the `file://` form to get a real 1-commit
  shallow clone locally) — then `pnpm install --frozen-lockfile` +
  `pnpm --filter @octoshell/graph test -- working-sets` inside it: identical
  2 failures, same assertion messages.
tags: [area/testing, area/graph-package, kind/ci-hazard]
aliases: [shallow clone graph tests, working-sets live-history test, fetch-depth graph CI]
---

## The hazard

`.github/workflows/ci.yml`'s `build` job uses `actions/checkout@v4` with no
`fetch-depth` override, so it gets the default **shallow clone (1 commit)**.
Any `packages/graph` test that calls `analyze()` / `harvest()` against the
real repo's own git history (via `REPO_ROOT = join(..., "..", "..", "..")`
from `packages/graph/test/`, a pattern several suites in this package use
deliberately, e.g. `test/e2e-gate.test.ts`'s bundled-`.mjs` check) sees almost
no analysable commits on CI, however many are visible in a normal local
clone. `harvest()` reading a near-empty `git log` means `analysis.workingSets`
(and similar derived fields) comes back empty — a test asserting "this repo's
real history produces X" is asserting something true of the checkout only
when it is not shallow.

## Where it bit

`packages/graph/test/working-sets.test.ts` (T7.1, PR #52) — both of its
live-history tests failed on CI while passing locally, matching this repo's
general "green locally, red on CI" pattern, **except this one instance DOES
reproduce locally** once you force a genuinely shallow clone rather than
running inside the full working tree (see `method` above for the exact repro
recipe, including the `file://` gotcha — a bare local-path `git clone --depth
1` silently upgrades to full history and will NOT reproduce this).

## What to check before trusting a "live repo history" test green

- Does the test read `REPO_ROOT`'s actual `git log` (via `analyze`/`harvest`)
  rather than a fixture repo built with `buildRepo`/`mkdtempClean`?
- If so, does `.github/workflows/ci.yml` set `fetch-depth: 0` (or at least
  something deep enough) on `actions/checkout`? As of 2026-08-10 it does not.
- A green `pnpm --filter @octoshell/graph test` in a normal local working
  tree is **not evidence** this class of test is CI-safe — it always has
  full history locally. Force a real shallow clone (`file://` form) to check.

## Fix directions (not decided here — flag for dev/tech-lead)

Either add `fetch-depth: 0` to `ci.yml`'s checkout step (fixes every current
and future live-history test in this package at once), or make each
live-history assertion tolerate/skip a shallow checkout explicitly. The first
is cheaper and matches the intent these tests were written with
("re-checks the mission's own headline claim against this repo's real commit
history" — deliberately not a fixture).

Related: [[graph-fixture-map-output-must-be-gitignored-before-a-second-run]]
