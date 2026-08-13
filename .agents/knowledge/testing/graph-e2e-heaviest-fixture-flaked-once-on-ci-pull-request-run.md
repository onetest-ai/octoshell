---
name: packages/graph e2e.test.ts's heaviest fixture flakes on CI pull_request runs — confirmed recurring
description: >-
  Two independent observed CI-only failures (neither reproduced locally, both
  cleared by a rerun of the identical commit) in e2e.test.ts's heaviest
  fixture, same test both times, two different concrete subprocess-failure
  shapes — upgraded from a single data point to a confirmed recurring
  pattern.
type: testing
verified: 2026-08-13
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

## Third investigation — 2026-08-11 (diagnosis pass, no third occurrence, no fix)

Dispatched specifically to diagnose (not just re-observe) after the second occurrence. Result:
**diagnostics improved, one real root-cause candidate eliminated (push/pull_request checkout
divergence), the previously-invisible occurrence-1 error text recovered, but the flake itself did
not recur and was not reproduced locally — no fix applied.**

### The push/pull_request checkout-divergence theory is RULED OUT for this test

`.github/workflows/ci.yml` has exactly one job (`build`) shared by both triggers, identical steps,
identical `fetch-depth: 0`. The only structural difference between a `push` and a `pull_request` run
of the same commit is that `actions/checkout` defaults to checking out
`refs/pull/<pr>/merge` (a synthetic merge commit) for `pull_request` events, vs. the raw branch head
for `push`. That difference is real, but it affects **this repository's own checked-out history**
(`REPO_ROOT`) — irrelevant here, because `buildRepo` never touches `REPO_ROOT`; it `git init`s a
brand-new throwaway repo under the OS temp dir. This is the same conclusion the original note
already drew for `fetch-depth`, extended to cover the merge-commit-vs-head-commit distinction too:
**neither explains a failure inside a from-scratch fixture repo.**

### Occurrence 1's error text, recovered

The original note recorded that occurrence 1's stderr was never captured because the assertion only
checked `.code`. That was true of the **assertion**, but the raw text was still sitting in the CI
job's raw log, just not in Vitest's own failure summary. Pulled via
`gh api repos/onetest-ai/octoshell/actions/jobs/93564366255/logs`:

```
error: Could not read 4e72611d2a81a53d3bc23945f0d053ee744f1ec3
fatal: Failed to traverse parents of commit 911004626f692f3508aca54ce62bb37fc62377a3
```

This is a `git log` parent-traversal failure inside `harvest()`'s `execFileSync("git", ["log",
"--no-merges", ...])` call — a git object (a commit's parent) that the fixture's own `git commit`
calls should have written moments earlier could not be read back. `runCli` caught it and returned
`{code: 1, stderr: "octograph: Command failed: ...\n" + that text}` via `runtimeError`, exactly as
designed — the CLI's own error plumbing was never the problem, only the test's assertion discarding
`.stderr`.

Occurrence 2's error (`fatal: could not parse HEAD`, raised straight out of `appendCommits`'s
`git commit` call, uncaught) was already visible pre-fix, because an uncaught `execFileSync` throw
reports its full message (stderr included) through Vitest's own reporter — no test-code defect there.

**Both are git object/ref resolution failures**, at two different points in the same sequential,
single-process, single-repo call chain (`git commit` #22 of ~62 failing to parse HEAD; a later
`git log` failing to read a parent object of an already-committed commit). Neither shape is
consistent with two processes racing the same repo — `buildRepo`/`appendCommits` run strictly
sequentially inside one Node process against one `mkdtempClean`-issued directory, and nothing else
in the suite touches that directory.

### What this pass ruled out, and how

- **Ambient git identity / config** — `buildRepo` sets `user.email`/`user.name` via `git config`
  (repo-local, not `--global`) before any commit; every commit's author/committer date is pinned via
  explicit `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` env vars. Nothing here depends on the ambient
  environment's git config, `$HOME`, or a global gitignore. Read, not tested (the code is
  unambiguous).
- **Non-deterministic fixture content or timestamps** — the failing fixture (test `(g)`) uses
  `spec.daysAgo` unset on every commit, so every commit in this specific fixture shares the exact
  same committer date; file content is `content ${seq + existing + i}`, a pure function of call
  order. Nothing under `src/` or this fixture touches the clock or RNG. Read, not tested.
- **`fetch-depth`/shallow-checkout and the push-vs-pull_request checkout ref divergence** — see
  above; structurally cannot reach a from-scratch `buildRepo` repo.
- **CPU scheduling contention, reproduced deliberately, did NOT trigger the failure**: ran the full
  40-file, 511-test `packages/graph` suite (this machine, 16 cores) under synthetic load — 20
  CPU-pegging busy-loops occupying every core (2x full run) and, separately, the same load with
  Vitest's thread pool constrained to `maxThreads=2`/`minThreads=2` (matching a GitHub-hosted
  runner's 2 vCPUs) — 3 full-suite runs total under contention, all green. Wall-clock time roughly
  doubled to tripled (`e2e.test.ts` went from a 13s baseline to 33–37s), confirming the load was
  real and the scheduler was genuinely starving the test process, but no git subprocess failed.
  **Conclusion: CPU/scheduling pressure alone, at this level, is not sufficient to reproduce
  either failure shape.** This doesn't rule out disk-I/O or memory pressure specific to an ephemeral
  GitHub-hosted runner's storage backend, which this machine's large local disk cannot emulate and
  which was not separately tested (no way to constrain disk throughput or free space from this
  sandbox; Docker, which could have emulated the runner's resource envelope more faithfully, was not
  usable in this environment).
- **Process/fd ulimits** — tried `ulimit -u 100` under the same load; this broke Vitest's own worker
  spawning outright (empty output, immediate `ELIFECYCLE` with no test results at all) rather than
  reproducing the target failure. Too aggressive to be informative; not repeated at a gentler value
  given the time budget. Left untested at an intermediate value (e.g. `ulimit -u 500–2000`) — a
  reasonable next step if this recurs.

### Diagnostics improvement made this pass

Every `expect(<runResult>.code).toBe(0)` in `packages/graph/test/e2e.test.ts`'s working-sets
describe block (9 call sites, covering tests a/b/c/d/e/g) now carries a message with the exit code
*and* `.stderr`, matching the pattern test `(f)` already used
(`expect(result.code, \`octograph exited ${result.code}: ${result.stderr}\`).toBe(0)`). A future
occurrence — of this shape or a new one — will show its cause directly in the Vitest failure output,
without needing a `gh api .../logs` archaeology pass. `pnpm --filter @octoshell/graph typecheck`,
`lint`, and `test` (511/511, including `e2e.test.ts` in isolation and as part of the full suite) all
pass after the change.

### Verdict

**Not reproduced. No fix applied — none was justified.** The mechanism remains "something about a
GitHub-hosted runner's environment, under this fixture's own git-subprocess load, occasionally
breaks a git object/ref read or write in an otherwise-correct, fully local, single-process sequence
of git commands" — narrowed from "somewhere in checkout/environment" to specifically "not the
checkout, not CPU scheduling, not fixture nondeterminism," but not further than that. The
[[graph-e2e-heaviest-fixture-flaked-once-on-ci-pull-request-run#What to do if this recurs again a
third time|original remediation menu]] (lighten the fixture, or wrap the git subprocess calls in a
small retry) still stands as the next move — deliberately not applied here, because neither has a
regression test that can prove it addresses a failure this session couldn't reproduce. **If it
recurs a third time, the assertions now in place will surface the exact git error immediately; that
message decides which of the two remediations (or a third) is right — don't guess ahead of it.**

## Fourth observation — 2026-08-11 (the predicted "third time" — confirmed, REMEDIATION NOW OVERDUE)

Seen on PR #72 (T6.2, octograph extension bridge; `apps/vscode-extension/src/host/octograph.ts` +
two test files — nowhere near `packages/graph`'s e2e fixture). `gh pr view 72
--json statusCheckRollup` showed the identical signature: two `build` checks on the same head SHA,
the `pull_request` run FAILURE, the `push` run SUCCESS. Same test:
`(g) keeps every surviving entry whole and every module it names headed when the budget truncates
the section itself`. **A third distinct concrete error shape**, captured directly in the Vitest
summary this time — proof the diagnostics improvement from the third investigation pass works as
designed:

```
Error: Command failed: git commit -q -m commit 26
error: invalid object 100644 573dd5863eb26452a6a9b25ec4b0e869f3f85123 for 'a2/f0.ts'
fatal: unable to read tree (019d1729fc83812de6c658dc036784863aa62080)
```

Thrown from `test/fixtures/repo.ts`'s `gitIn` → `appendCommits` → `buildRepo`, same call path as
occurrence 2 — but a **write-time object-store corruption** (`git commit`'s own tree write reports
its just-staged blob unreadable), not occurrence 2's ref-resolution failure (`could not parse HEAD`)
or occurrence 1's downstream `git log` parent-traversal failure. Three occurrences, three shapes, all
inside the same ~62-commit sequential `git commit` loop, all clearing on `gh run rerun --failed`
(confirmed here too — rerun of job 31520588786 went SUCCESS, `mergeStateStatus` CLEAN).

This is the note's own predicted third-occurrence trigger. Per the existing remediation menu, this
should now get **real remediation** (lighten the fixture, or wrap `buildRepo`/`appendCommits`'s git
subprocess calls in a small retry) rather than a fifth log entry next time. This session (a QA merge
gate, not a dev/js-dev session) reported it explicitly and reran rather than applying a fix — flagging
here for whichever role picks up `packages/graph`'s test fixtures next.

## Fifth and sixth observations, and the decision — 2026-08-12

Two more, both on unrelated diffs, both the same push-versus-pull_request split on an identical
SHA. The diagnostics added on the third pass paid off again: the failure now names its own cause
in the Vitest summary rather than requiring log archaeology.

    (g) keeps every surviving entry whole and every module it names headed ...
      -> Command failed: git commit -q -m commit 25
         fatal: could not parse HEAD
      at test/fixtures/repo.ts:19

**It is the fixture BUILDER failing to create a commit, not harvest failing to read history.**
Every theory before this was aimed at the wrong half of the test.

### Measured rate

**1.9% per suite execution** — 5 defensible occurrences in 268 executions, 95% CI 0.8-4.3%. Two
jobs run per push, so ~3.7% per push, about 1 in 27.

68 deliberate reproduction runs on real ubuntu-latest runners produced ZERO failures: 48 of
test/e2e.test.ts alone, then 20 of the full suite across 4 shards. At 1.9% that is unremarkable
(p ~ 28%) and it rules out the ~10% the clustering suggested — an overreading that was stated as
fact and had to be corrected.

### Ruled out with evidence

Disk and inode pressure (~5 MB across 92 fixtures; runners start clean) - concurrency on macOS (24
parallel builds x 47 commits, clean) - CPU contention (green under 20 busy loops, and pinned to 2
threads) - inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
GIT_COMMON_DIR (nothing in repo or CI sets any) - setup-e2e-gate's process-wide PATH mutation
(synchronous, and vitest forks per file) - glob-based temp cleanup (none exists) - the
vscode-extension tmpdir leak (10 MB, different package) - and the checkout-ref theory: failures
ALTERNATE between push and pull_request, so the trigger is not the variable. That last one retired
the theory this note carried from its first entry.

### Decision: mitigate, do not chase

At 1.9%, chasing the cause is a several-hundred-run proposition. The fixture is infrastructure, not
the system under test, so `appendCommits` retries a failed git call ONCE — bounded, and loud.

Three properties keep that from being "retry until green", which is what hid this for two days:
exactly one retry and a second consecutive failure throws with BOTH state dumps; it PRINTS the repo
state that prompted the retry, every line prefixed because CI interleaves parallel files; and the
state is captured BEFORE the retry, since a successful retry would otherwise destroy the only
evidence. Both properties are asserted by test/fixture-retry.test.ts rather than trusted.

**Exit condition:** if `[fixture retry]` starts appearing regularly in CI logs, or a `failed TWICE`
ever lands, escalate — and the paired before/after state dumps will finally say what changed.

## Seventh observation — 2026-08-13 — THE EXIT CONDITION FIRED

The previous section's exit condition was: *"if `[fixture retry]` starts appearing regularly in CI
logs, or a `failed TWICE` ever lands, escalate."* **A `failed TWICE` landed**, on PR #95
(head `7eafc0e`, a pack/docs-only diff touching no `packages/graph` source). Same push-versus-
pull_request split on an identical SHA: `push` run 31674649730 SUCCESS, `pull_request` run
31674652723 FAILURE, started two seconds apart. `gh run rerun --failed` went SUCCESS, as always.

Same test as all six prior occurrences. The mitigation worked exactly as designed — it retried once,
printed the state, and threw with both dumps — so for the first time there is real evidence.

### The evidence the retry was built to capture

```
[fixture retry] commit 24 of 62 failed in /tmp/octograph-NP974C
[fixture retry] Command failed: git commit -q -m commit 23 | error: bad tree object HEAD
[fixture retry]   root exists: true      .git exists: true
[fixture retry]   HEAD file: ref: refs/heads/main        refs/heads: main
[fixture retry]   index.lock: false
[fixture retry]   git status: <failed: Command failed: git status --porcelain=v1 -b>
[fixture retry]   git rev-list --count --all: <failed>
→ fixture step failed TWICE: commit 24 of 62
  first:  Command failed: git commit -q -m commit 23
  second: Command failed: git commit -q -m commit 23
```

Three findings, in order of how much they change the model:

1. **The before and after state dumps are byte-identical.** Nothing changed between the two
   attempts. This retires the transient-race model the whole mitigation rested on: the repository is
   left *persistently* broken, not momentarily inconsistent. A bounded retry cannot help, and no
   larger retry budget would either.
2. **`error: bad tree object HEAD` is a fourth distinct shape**, alongside `git log` parent
   traversal, `fatal: could not parse HEAD`, and the write-time object-store corruption. With
   `git status` and `git rev-list` both unusable while `HEAD`, `refs/heads/main` and `.git` all exist
   and `index.lock` is absent, the damage is in the **object store**, not the refs. Every shape so
   far is consistent with that one locus.
3. **Two different fixtures degraded in the same job** — `/tmp/octograph-NP974C` at commit 24 of 62,
   and `/tmp/octograph-0ijNv7` at its commit 1 of 1. The note's entire framing, from its title
   onward, is that this is *the heaviest fixture*. That framing is now wrong: a second, trivial
   one-commit fixture broke in the same run.

### An unverified lead, stated as unverified

Both `[fixture retry]` blocks carry timestamps within ~10 ms of each other (06:40:33.635 and
06:40:33.644), which would suggest a single runner-wide event rather than a per-fixture race.
**Do not treat this as simultaneity.** Vitest buffers console output per test file and flushes at
the end of the run, so near-identical timestamps are the expected artifact of two files finishing
together. Establishing whether the two failures were genuinely concurrent needs an in-fixture
timestamp at the moment of failure, which does not exist today. Finding 3 stands on its own without
this; the lead does not.

### Where this leaves the decision

The 2026-08-12 decision was *mitigate, do not chase*, justified by a 1.9% rate and a bounded retry
that would make the next one legible. It did exactly that, and what it produced says the mitigation
cannot work: an identical before/after state means there is nothing to retry *into*. The next step
is no longer a fifth log entry, and it is no longer a retry — it is to establish what damages the
object store, starting from finding 3 (whatever it is, it is not specific to a 62-commit fixture).

Left undone deliberately: the escalation itself is a decision about where to spend several hundred
CI runs, and belongs to whoever owns `packages/graph`, not to the session that happened to trip it.
