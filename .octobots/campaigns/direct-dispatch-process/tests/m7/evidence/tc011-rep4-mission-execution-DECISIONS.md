# mission-execution: reconcile against pack v57

## Kept local

- RESOLVED: project test commands: local names this project's commands (`cd edgeserver && uv run pytest -n auto --no-cov <files>`, `make edgeserver-test-fast`, `make ci`, `uv run pytest`, search scope `edgeserver/app` and `edgeserver/tests`); upstream's generic "read the project's declared test lanes" rules are taken and local's commands are kept right after them as this project's instance.

## Taken from upstream

- RESOLVED: removal of the Workflow tool and workflow.js, orchestrator dispatches sub-agents: both sides made the same change (description, section "No Workflow tool", dispatch rules 1-5).
- RESOLVED: "Three loops: when the tests run again" section: upstream only.
- RESOLVED: gate base branch passed in the dispatched briefs instead of a `baseBranch` arg: upstream only.
- RESOLVED: "Do not end a mission run when the last task has merged" (no `MISSION_TASKS_MERGED` status): upstream only.
- RESOLVED: dead-agent rule gains "Resume from the board and git, never from a cache"; rules renumbered 8-10 after the new lanes rule: upstream only.

## Conflicts

- RESOLVED: "workflow failures recorded in" `CLAUDE.md` vs the project's `CLAUDE.md` / `AGENTS.md`: not policy; upstream's wording is the generic form of local's reference. Upstream taken.
- RESOLVED: reviewer questions "dispatches the dev ... " vs "**relays** them: it dispatches ...": same meaning, wording only. Upstream taken.
- RESOLVED: lanes rule 6 and long-command rule 7 (project-specific vs generic): not policy; see Kept local for how the two were combined. The Mac-specific `timeout` note is covered by upstream's portability bullet.
- ESCALATED: pre-merge full-suite and CI wait: local "In this repo there is no local pre-push suite (removed 2026-10-02); the full suite runs in GitHub Actions on the PR, and the land step waits for it (`gh pr checks --watch`) before merging"; upstream "the full fast lane runs at the QA + land step, which also waits for the PR's CI checks (`gh pr checks --watch`) before merging, where the project has CI"; question should the land step itself run the full fast lane (`make edgeserver-test-fast`) before merging, or only wait for the full suite in GitHub Actions as it does now?
