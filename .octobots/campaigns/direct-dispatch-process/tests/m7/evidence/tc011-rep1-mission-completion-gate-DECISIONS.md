# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: project lane commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`): kept right after upstream's generic test-lane rule as this project's instance.

## Taken from upstream

- RESOLVED: orchestrator-dispatch gate, relay of Sage/Rio questions, description: both sides made the same change against base.
- RESOLVED: hook fires only on a real transition to `done` (recovery note): upstream only.
- RESOLVED: "Dispatch rules are those of ..." vs "are the same as ...": same rule, wording only; upstream wording.
- RESOLVED: generic test-lane rule (read declared lanes, brief by name): replaces local's hard-coded commands, which are kept as the instance above.
- RESOLVED: Sage names the backing record "where the project's CLAUDE.md / AGENTS.md asks for one": generalises local's "(see CLAUDE.md)"; same rule.
- RESOLVED: transcript locations (`~/.claude/projects/<slug>`, `$CLAUDE_CONFIG_DIR`, legacy repo-local): upstream only.
- RESOLVED: `runs.json` campaign-level rows: upstream only.

## Conflicts

- ESCALATED: what counts as green: local "0 failed, 0 xfailed, and no skip without a stated environmental reason; an xfail or a bare skip is a parked defect"; upstream "0 failed, 0 xfailed or todo, and no skip without a stated environmental reason; an xfail, a todo or a bare skip is a parked defect" (so a todo also blocks the gate); question should a `todo` test block the mission gate (upstream) or not (local)?
