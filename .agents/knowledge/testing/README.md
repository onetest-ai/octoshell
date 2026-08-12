# testing/

Suite structure and harness behavior beyond what `AGENTS.md` § Testing already states — flaky-test
notes, fixture-tree conventions worth knowing before adding a new one, coverage-gate surprises.

**Not here:** restating the test command list or file counts — that's `AGENTS.md` § Testing,
already current as of 2026-08-09.

## Index

- [graph-fixture-map-output-must-be-gitignored-before-a-second-run.md](graph-fixture-map-output-must-be-gitignored-before-a-second-run.md)
  — a second `analyze()`/map run in a fixture repo must `.gitignore` the first
  run's own output before `git add -A`, or the tool's own artifact becomes a
  bogus module in the next commit's history.
- [graph-ci-checkout-is-shallow-live-history-tests-return-empty.md](graph-ci-checkout-is-shallow-live-history-tests-return-empty.md)
  — `packages/graph` tests that call `analyze()`/`harvest()` against
  `REPO_ROOT`'s real git log see only 1 commit on CI (`actions/checkout@v4`
  default `fetch-depth`), not this repo's full history; verified by forcing a
  real shallow clone locally and reproducing the same failure.
- [graph-fixture-two-module-boundary-needs-a-third-unrelated-component.md](graph-fixture-two-module-boundary-needs-a-third-unrelated-component.md)
  — a fixture with only two modules joined by one co-change edge won't
  exercise Louvain's boundary-crossing detection (`workingSets`); Louvain
  trivially merges a two-node one-edge graph into a single community, so add
  a third, unrelated background component (the suite's own `backgroundChurn`
  pattern).
- [graph-e2e-heaviest-fixture-flaked-once-on-ci-pull-request-run.md](graph-e2e-heaviest-fixture-flaked-once-on-ci-pull-request-run.md)
  — CONFIRMED recurring CI-only failure (2 independent occurrences, PR #55
  and PR #62) in `e2e.test.ts`'s heaviest (most git-subprocess-intensive)
  fixture; both times the same-commit `push` run and a manual rerun went
  green, but the two occurrences threw different concrete errors. Read
  before re-investigating from scratch; a third occurrence should trigger
  real remediation, not another log entry.
