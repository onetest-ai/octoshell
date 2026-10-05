# mission-execution: reconcile against pack v57

## Kept local

- RESOLVED: project lane commands (scoped `uv run pytest -n auto --no-cov`, `make edgeserver-test-fast`, serial coverage lane): kept right after upstream's generic test-lane rule as this project's instance.
- RESOLVED: search scope `edgeserver/app`, `edgeserver/tests`: kept after upstream's generic scoping rule as this project's instance.
- RESOLVED: long-command examples (`make ci`, `uv run pytest`): kept as this project's instance of "name the lane command".
- RESOLVED: no local pre-push suite (removed 2026-10-02), full suite in GitHub Actions, land waits on `gh pr checks --watch`: kept after upstream's rule as this project's instance.

## Taken from upstream

- RESOLVED: description and no-Workflow section: both sides made the same change against base.
- RESOLVED: "workflow failures recorded in the project's CLAUDE.md / AGENTS.md": generalises local's "CLAUDE.md"; same rule.
- RESOLVED: reviewer questions are relayed by the orchestrator: same rule, upstream wording.
- RESOLVED: generic test-lane rule (read declared lanes, brief by name), portability note, rule renumbering (8-10), "resume from the board and git, never from a cache": upstream only.
- RESOLVED: "Three loops: when the tests run again" section: upstream only.
- RESOLVED: gate base branch passed in the orchestrator's briefs (no `baseBranch` arg), "do not end a mission run when the last task has merged": upstream only; local still had base's text.

## Conflicts

- RESOLVED: where the full suite runs (local: GitHub Actions on the PR; upstream: full fast lane at QA + land, then CI checks where the project has CI): not a policy difference, both prescribe the same flow. Upstream's rule taken, local's CI specifics kept as the instance.
