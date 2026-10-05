# mission-execution: reconcile against pack v57

## Kept local

- RESOLVED: project lane commands (scoped tests `uv run pytest -n auto --no-cov`, full suite `make edgeserver-test-fast`, searches scoped to `edgeserver/app` and `edgeserver/tests`, this Mac has no `timeout`): local made upstream's generic lane rule concrete for this project; upstream's generic rule is taken and local's commands follow it as this project's instance.
- RESOLVED: no local pre-push suite (removed 2026-10-02); full suite runs in GitHub Actions and the land step waits with `gh pr checks --watch`: concrete instance of upstream's "waits for the PR's CI checks, where the project has CI".

## Taken from upstream

- RESOLVED: Three loops (implementation, testing, fixing) section: upstream only.
- RESOLVED: "workflow failures recorded in the project's CLAUDE.md / AGENTS.md" wording: upstream's generalisation of local's "CLAUDE.md".
- RESOLVED: reviewer questions are "relayed" by the orchestrator: upstream's wording of the same rule.
- RESOLVED: rule numbering 6-10 (local had two rules numbered 7): upstream's numbering.
- RESOLVED: a dead agent is retried "from the board and git, never from a cache": upstream only.
- RESOLVED: the mission's base branch is passed in each gate phase brief instead of a `baseBranch` arg: both removed the workflow arg; upstream's wording taken.
- RESOLVED: do not end a run "when the last task has merged" instead of at `MISSION_TASKS_MERGED`: upstream's wording.
- RESOLVED: removal of the "Board-defined workflows" section in favour of direct `Agent` dispatch, and the description change: both sides made the same change.

## Conflicts

- RESOLVED: lane rule wording (upstream generic, local concrete): not a policy conflict (a generic rule made concrete); see Kept local.
