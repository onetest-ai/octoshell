# mission-execution: reconcile against pack v57

## Kept local

- RESOLVED: this project's subproject paths (`edgeserver/app`, `edgeserver/tests`): kept right after upstream's generic search-scope rule as this project's instance.
- RESOLVED: this project's test lanes (`cd edgeserver && uv run pytest -n auto --no-cov <files>`, `make edgeserver-test-fast` with its timing note, serial coverage lane): kept right after upstream's generic lane rule as this project's instance.
- RESOLVED: long-command names (`make ci`, `uv run pytest`): kept as this project's instance of "name the lane command in the brief".

## Taken from upstream

- RESOLVED: no-Workflow, direct-dispatch restructure (description, mission loop, dispatch rules 1-5, phases, QA verification notes block, tokenomics capture, resuming a stalled mission, orchestrator-as-writer cautions, model tiering wording): local and upstream made the same change against base.
- RESOLVED: "workflow failures recorded in the project's CLAUDE.md / AGENTS.md": generic wording instead of local's CLAUDE.md-only pointer.
- RESOLVED: reviewer questions are "relayed" by the orchestrator: wording, upstream's.
- RESOLVED: generic test-lane rule and portability note on the `timeout` binary (read `AGENTS.md § Test lanes`, brief agents with the lane commands by name): upstream's generic rule; local's concrete commands are the instance above.
- RESOLVED: rule numbering (duplicate 7 split into 7 and 8, then 9 and 10) and "Resume from the board and git, never from a cache": upstream only.
- RESOLVED: new section "Three loops: when the tests run again": upstream only; local had deleted the old loop table and has no competing text.
- RESOLVED: gate base branch passed in the briefs, and "do not end a mission run when the last task has merged": upstream's wording; local still referred to the removed `baseBranch` arg and `MISSION_TASKS_MERGED`.

## Conflicts

- ESCALATED: what the land step runs and waits on before merging: local "the full suite runs in GitHub Actions on the PR, there is no local pre-push suite (removed 2026-10-02), and the land step waits for it with `gh pr checks --watch` before merging"; upstream "the full fast lane runs at the QA + land step, which also waits for the PR's CI checks (`gh pr checks --watch`) before merging, where the project has CI"; question should the QA + land step run the full fast lane locally before merging (upstream), or rely on the CI run alone, with no local full suite (local)?
