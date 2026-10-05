# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: test-lane commands (phase 1): upstream's generic "declared test lanes" rule is taken; local's `make edgeserver-test-fast`, `make edgeserver-test` / `make coverage` and `-n auto --cov` follow it as this project's instance.

## Taken from upstream

- RESOLVED: direct-dispatch gate (no Workflow tool), Rio's questions relayed by the orchestrator, dispatch rules, per-phase verdict JSON, one review round and one fix round, black-box QA with re-check of fixed criteria, tokenomics capture and backfill: local and upstream made the same change against base; upstream wording taken.
- RESOLVED: QA names the pre-existing record "where the project's CLAUDE.md / AGENTS.md asks for one": local said "(see CLAUDE.md)"; non-policy wording difference, upstream's more general form taken.
- RESOLVED: hook fires only on a real transition to `done` (note); transcript locations in tokenomics capture; campaign-level `runs.json` rows; `Gate timing` section: upstream only.

## Conflicts

- RESOLVED (user, 2026-10-05): what counts as green: keep local; 0 xfailed blocks the merge. Local's rule is installed as written: 0 failed, 0 xfailed, no skip without a stated environmental reason; an xfail or bare skip is a parked defect unless the user signs it off.
