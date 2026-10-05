# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: this project's test-lane commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`): kept right after upstream's generic lane rule as this project's instance.
- RESOLVED: Sage's backing record pointer (`see CLAUDE.md`): kept as this project's instance after upstream's generic "where the project's CLAUDE.md / AGENTS.md asks for one".

## Taken from upstream

- RESOLVED: description, "no one else, always through the orchestrator's relay", Rio's questions relayed by the orchestrator, "orchestrator dispatches one sub-agent per phase" gate, inputs, dispatch rules, relay rule, phases 1-5 structure, mission-execution cross-reference: local and upstream made the same change against base.
- RESOLVED: note that the hook fires only on a real transition to `done`: upstream only.
- RESOLVED: generic test-lane rule (fast lane, coverage once on the coverage lane, read `AGENTS.md § Test lanes`): upstream's generic rule, local's concrete commands are the instance above.
- RESOLVED: Sage records the backing record "where the project's CLAUDE.md / AGENTS.md asks for one": upstream's generic wording.
- RESOLVED: "Dispatch rules are those of mission-execution": wording only, upstream's.
- RESOLVED: tokenomics transcript locations (`~/.claude/projects/<slug>`, `$CLAUDE_CONFIG_DIR`, legacy repo-local): upstream only.
- RESOLVED: `runs.json` campaign-level rows: upstream only.

## Conflicts

- ESCALATED: what counts as green: local "0 failed, 0 xfailed, and no skip without a stated environmental reason; an xfail or a bare skip is a parked defect"; upstream "0 failed, 0 xfailed or todo, and no skip without a stated environmental reason; an xfail, a todo or a bare skip is a parked defect"; question should a `todo` also block the gate (upstream), or only failed, xfail and bare skip (local)?
