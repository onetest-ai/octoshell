---
name: packages/graph e2e.test.ts's heaviest fixture flaked once on a CI pull_request run
description: >-
  A single observed CI-only failure (not reproduced locally, not reproduced on
  a second CI run of the identical commit) in e2e.test.ts's heaviest fixture —
  logged as a single-instance data point for the next gate pass to weigh, not
  a confirmed recurring flake.
type: testing
verified: 2026-08-10
method: >-
  PR #55 (T7.4, packages/graph/test/e2e.test.ts, test-only diff). `gh pr view
  55 --json statusCheckRollup` showed 2 `build` checks on the identical head
  SHA (a1149aa): the `pull_request`-triggered run FAILURE, the
  `push`-triggered run (fired seconds earlier on the same SHA) SUCCESS.
  Failure: `test/e2e.test.ts > ... (g) keeps every surviving entry whole and
  every module it names headed when the budget truncates the section itself`
  — `expect(generous.code).toBe(0)` got `1` (a `runCli` in-process call
  returned a non-zero code; the assertion doesn't capture stderr so the
  underlying thrown error's message wasn't visible in the CI log). 4x full
  `pnpm test` runs locally (16-core machine) never reproduced it — neither
  isolated (`vitest run test/e2e.test.ts` x3) nor as part of the full
  monorepo suite (x3 more). `gh run rerun <id> --failed` on the failed run
  went SUCCESS on retry, same commit, same code.
tags: [area/testing, area/graph-package, kind/ci-hazard]
aliases: [test g flaky, e2e test g CI flake, working sets budget truncation flaky]
---

## The observation

`test/e2e.test.ts`'s test `(g) keeps every surviving entry whole and every
module it names headed when the budget truncates the section itself` builds
the heaviest fixture in the file — four independent 6-file communities (24
files) plus 15 pairs of background churn, ~62 commits total, each requiring
its own `git commit` subprocess via `buildRepo`/`appendCommits`. Under a
`pull_request`-triggered CI run it failed once with the "generous" (untruncated)
`runCli(["map", "--min-commits", "5"], repo, T4_NOW)` call returning exit code
1 instead of 0. The `push`-triggered run on the exact same commit, started
within the same minute, passed. A manual rerun of the failed job also passed.

This is **one data point**, not a confirmed recurring pattern — do not
over-index on it. It is logged because the investigation to rule out a real
regression (checking two independent CI signals + an explicit rerun, per this
repo's "local green isn't sufficient" rule) is expensive to redo from
scratch, and because the PR that hit it touched **zero `src/` files** — a
test-only diff, so there was no code path a genuine regression could hide
behind.

## Working theory (not confirmed)

`pull_request` and `push` events on GitHub Actions can run on runners with
different/variable resource allocation even for the identical commit. This
test's fixture is unusually git-subprocess-heavy relative to the rest of the
file (compare: most other tests in this suite use 1-2 modules and <20
commits). A resource-constrained runner spawning ~62 sequential `git commit`
processes plus the CLI's own `git log` harvest is a plausible place for a
transient subprocess failure (ENOMEM, EMFILE, or similar) that a 16-core dev
machine won't reproduce. This is **distinct** from
[[graph-ci-checkout-is-shallow-live-history-tests-return-empty]] — that hazard
is about `REPO_ROOT`'s own shallow-checked-out history; this fixture is a
from-scratch `buildRepo` repo with full local history, unaffected by
`fetch-depth`.

## What to do if this recurs

- Check `gh pr view <n> --json statusCheckRollup` for a same-SHA
  push-vs-pull_request split before assuming a real regression — that split
  is itself decent evidence of transience.
- `gh run rerun <id> --failed` and treat a green rerun on the identical
  commit as real evidence, not a dismissal — the mission gate rule against
  trusting "local green" doesn't forbid trusting "CI green now, on a rerun,
  with a second independent CI signal already agreeing" — it forbids trusting
  *local* green as a substitute for *any* CI green.
- If this specific test (or another equally git-subprocess-heavy fixture in
  this file) fails on CI a **second** time, upgrade this note: capture the
  actual thrown error (the current assertion only checks `.code`, not
  `.stderr` — a future repro should log it) before writing it off again as
  infra noise.

Related: [[graph-ci-checkout-is-shallow-live-history-tests-return-empty]] ·
[[graph-fixture-map-output-must-be-gitignored-before-a-second-run]]
