# mission-execution: reconcile against pack v57

## Kept local

- RESOLVED: project instance of the fast test lane (rule 6): upstream's generic lane rule is taken; local's concrete commands (`uv run pytest -n auto --no-cov`, `make edgeserver-test-fast`, serial coverage lane only at the gate) follow it as this project's instance.
- RESOLVED: project instance of subproject paths (rule 5): upstream's generic rule is taken; `edgeserver/app` and `edgeserver/tests` are kept as this project's instance.
- RESOLVED: lane command names `make ci`, `uv run pytest` (rule 7): kept as this project's instance of "name the lane command".

## Taken from upstream

- RESOLVED: description and version marker, direct-dispatch section, dispatch rules 1-4, 8-10 (local's duplicate "7." numbering dropped), phase sequence, `## QA verification` land step, tokenomics and resume text, all workflow-to-sub-agent wording: local and upstream made the same change, or upstream only.
- RESOLVED: "Why this replaced workflows" pointing at the project's `CLAUDE.md` / `AGENTS.md`: upstream generalises local's `CLAUDE.md` reference.
- RESOLVED: rule 11 (servers and QA environments via `qa-env.mjs`), "Mission QA: run the test cases live", "Three loops", the Mission QA references in the gate and E2E paragraphs, the set-status wording (gate ticks mission criteria in phase 5), the exception for the last Mission QA task writing mission `notes`, the "Do not end a mission run when the last task has merged" wording: upstream only.
- RESOLVED: brief the gate with the orchestrator-passed base branch instead of a `baseBranch` arg: both sides dropped the Workflow args.

## Conflicts

- ESCALATED: what runs before a merge (per-agent test budget and the land step): local build runs scoped tests only, there is no local pre-push suite (removed 2026-10-02), the full suite runs in GitHub Actions on the PR and the land step waits for it with `gh pr checks --watch` before merging; upstream build runs scoped tests only, and the full fast lane runs at the QA + land step, which also waits for the PR's CI checks where the project has CI; question which does this project want at the land step: only the CI wait (local), or a full local fast-lane run and then the CI wait (upstream)?
