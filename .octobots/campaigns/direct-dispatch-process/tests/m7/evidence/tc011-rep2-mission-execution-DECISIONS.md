# mission-execution: reconcile against pack v57

## Kept local

- RESOLVED: scoped searches: upstream's generic rule taken; local's paths (`edgeserver/app`, `edgeserver/tests`) kept after it as this project's instance.
- RESOLVED: fast test lane: upstream's generic rule (read the declared lanes, brief by name) taken; local's commands (`cd edgeserver && uv run pytest -n auto --no-cov <files>`, `make edgeserver-test-fast`) kept as this project's instance.
- RESOLVED: no local pre-push suite (removed 2026-10-02), full suite runs in GitHub Actions and the land step waits with `gh pr checks --watch`: kept as this project's instance after upstream's generic budget rule, which also waits for CI where the project has CI. Neither side changes who may merge or what blocks it; both wait for CI before merging.

## Taken from upstream

- RESOLVED: no Workflow tool or workflow.js; the orchestrator dispatches sub-agents; phases, dispatch rules, QA `## QA verification` notes block, resume without a run id, tokenomics, shared-tree rules, model tiering: both sides made these changes the same, or only upstream did; taken.
- RESOLVED: "Three loops: when the tests run again" section and the `description` frontmatter text: upstream only; taken.
- RESOLVED: "relays" wording, gate base branch passed in briefs, "when the last task has merged", "Resume from the board and git, never from a cache": wording; upstream taken.
- RESOLVED: dispatch rule numbering: upstream's 1-10 taken (local had two rules numbered 7).

## Conflicts

- RESOLVED: why workflows were replaced: local cited `CLAUDE.md`; upstream cites the project's `CLAUDE.md` / `AGENTS.md`. Not policy; upstream taken.
