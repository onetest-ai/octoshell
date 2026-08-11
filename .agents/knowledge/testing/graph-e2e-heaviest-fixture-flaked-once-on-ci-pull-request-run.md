---
name: packages/graph e2e.test.ts's heaviest fixture flakes on CI pull_request runs — confirmed recurring
description: >-
  Two independent observed CI-only failures (neither reproduced locally, both
  cleared by a rerun of the identical commit) in e2e.test.ts's heaviest
  fixture, same test both times, two different concrete subprocess-failure
  shapes — upgraded from a single data point to a confirmed recurring
  pattern.
type: testing
verified: 2026-08-11
method: >-
  Occurrence 1 — PR #55 (T7.4, packages/graph/test/e2e.test.ts, test-only
  diff). `gh pr view 55 --json statusCheckRollup` showed 2 `build` checks on
  the identical head SHA (a1149aa): the `pull_request`-triggered run FAILURE,
  the `push`-triggered run (fired seconds earlier on the same SHA) SUCCESS.
  Failure: `expect(generous.code).toBe(0)` got `1` (a `runCli` in-process call
  returned a non-zero code; the assertion doesn't capture stderr so the
  underlying thrown error's message wasn't visible in the CI log). 4x full
  `pnpm test` runs locally (16-core machine) never reproduced it. `gh run
  rerun <id> --failed` went SUCCESS on retry, same commit.

  Occurrence 2 — PR #62 (T4.5, the conflicts-command merge gate;
  packages/graph/src/{conflicts,cli,config,own,index}.ts +
  test/{conflicts,cli,conventions}.test.ts — a real diff this time, not
  test-only). `gh api .../commits/<sha>/check-runs` on head SHA
  ec444a67e7ed381d6e2d9c14cc109842a75784ad showed the same split: the
  `pull_request` run (event, createdAt 09:09:40Z) FAILURE, the `push` run on
  the identical SHA (createdAt 09:09:36Z, ~4s earlier) SUCCESS. Same test
  failed. This time the thrown error was captured: `Command failed: git
  commit -q -m commit 22` / `fatal: could not parse HEAD`, raised from
  `test/fixtures/repo.ts`'s `gitIn` → `appendCommits` → `buildRepo` path — a
  git subprocess failure partway through the fixture's ~62 sequential
  commits, not the exit-code-1 shape seen in occurrence 1. Locally, the full
  446-test `pnpm --filter @octoshell/graph test` run (including this exact
  test) passed clean. `gh run rerun <id> --failed` went SUCCESS on retry,
  same commit — confirmed via `gh pr view 62 --json mergeStateStatus` going
  CLEAN afterward.
tags: [area/testing, area/graph-package, kind/ci-hazard]
aliases: [test g flaky, e2e test g CI flake, working sets budget truncation flaky]
---

## The observation

`test/e2e.test.ts`'s test `(g) keeps every surviving entry whole and every
module it names headed when the budget truncates the section itself` builds
the heaviest fixture in the file — four independent 6-file communities (24
files) plus 15 pairs of background churn, ~62 commits total, each requiring
its own `git commit` subprocess via `buildRepo`/`appendCommits`. It has now
failed on a `pull_request`-triggered CI run **twice**, on two unrelated PRs
(one test-only, one a real `src/` diff), always with the matching `push` run
on the identical head SHA passing, and always clearing on an explicit rerun
of the same commit. Locally it has never reproduced across either
investigation.

The two failures took **different concrete shapes**:

1. **Occurrence 1** (PR #55): the "generous" (untruncated) `runCli(["map",
   "--min-commits", "5"], repo, T4_NOW)` call returned exit code `1` instead
   of `0`. No stderr was captured (the assertion only checked `.code`), so
   the underlying cause was never seen.
2. **Occurrence 2** (PR #62): a `git commit` subprocess itself failed
   mid-fixture — `fatal: could not parse HEAD` on `commit 22` of the ~62 the
   fixture issues, thrown out of `test/fixtures/repo.ts`'s `gitIn` helper
   before `runCli` was ever invoked.

Two different failure points (a `git commit` subprocess vs. the CLI's own
`git log` harvest downstream of a complete fixture) are both consistent with
the same root mechanism: this fixture is unusually git-subprocess-heavy
relative to the rest of the file, and something about it is fragile under
whatever differs between a `pull_request` and `push` runner for the same
commit.

## Working theory (two data points now, still not root-caused)

`pull_request` and `push` events on GitHub Actions can run on runners with
different/variable resource allocation even for the identical commit. This
fixture's ~62 sequential `git commit` subprocesses (compare: most other tests
in this suite use 1-2 modules and <20 commits) are a plausible place for a
transient subprocess failure (ENOMEM, EMFILE, a raced `.git/index.lock`, or
similar) that a well-resourced dev machine won't reproduce — and the two
different observed failure shapes (a corrupted-looking `git commit` outright
failing vs. a downstream `git log` harvest returning a bad exit code) are
both symptoms consistent with "something about this runner's git/filesystem
state under load is occasionally wrong," not evidence of two unrelated bugs.
This is **distinct** from
[[graph-ci-checkout-is-shallow-live-history-tests-return-empty]] — that
hazard is about `REPO_ROOT`'s own shallow-checked-out history; this fixture
is a from-scratch `buildRepo` repo with full local history, unaffected by
`fetch-depth`.

## What to do if this recurs again (a third time)

- Check `gh pr view <n> --json statusCheckRollup` (or `gh api
  .../commits/<sha>/check-runs` for event-level detail) for a same-SHA
  push-vs-pull_request split before assuming a real regression — that split
  has now held on both observed occurrences and is decent evidence of
  transience on its own.
- `gh run rerun <id> --failed` and treat a green rerun on the identical
  commit as real evidence, not a dismissal — the mission gate rule against
  trusting "local green" doesn't forbid trusting "CI green now, on a rerun,
  with a second independent CI signal already agreeing" — it forbids trusting
  *local* green as a substitute for *any* CI green.
- **A third occurrence should trigger real remediation, not another log
  entry.** Two independent corroborating failure shapes is enough to justify
  spending effort rather than continuing to treat this as pure infra noise:
  either lighten this fixture (fewer sequential git subprocesses — e.g. batch
  commits, or shrink the community/churn counts if the budget-truncation
  behavior it exercises survives a smaller fixture), or wrap
  `buildRepo`/`appendCommits`'s git subprocess calls in a small retry.

Related: [[graph-ci-checkout-is-shallow-live-history-tests-return-empty]] ·
[[graph-fixture-map-output-must-be-gitignored-before-a-second-run]]

## Second observation — 2026-08-11

Seen again on PR #64 (`fix/octograph-attribution-branch-disambiguation`), a diff touching only
`attribution.ts` and its tests — nothing near the e2e fixture. Same signature: the `push`-triggered
run failed while the concurrent `pull_request` run on the identical SHA passed, and
`gh run rerun --failed` went green.

That is two independent observations, on unrelated diffs, both showing the same pass/fail split
across two runs of one commit. It is no longer reasonable to treat this as a one-off data point:
**it is a real flake and it should be diagnosed rather than re-observed.** The next gate that has
room should reproduce it under load rather than retrying past it — the retry is what has kept it
invisible.
