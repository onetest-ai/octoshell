# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: project lane commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`): local made the lane rule concrete; upstream's generic rule is taken and local's commands follow it as this project's instance.

## Taken from upstream

- RESOLVED: the hook fires only on a real transition to `done`, and how to recover a skipped gate: upstream only.
- RESOLVED: Rio always questions the devs through the orchestrator's relay: both sides removed direct dev calls; upstream's wording taken.
- RESOLVED: the pre-existing record is named "where the project's CLAUDE.md / AGENTS.md asks for one": upstream's generalisation of local's "see CLAUDE.md".
- RESOLVED: transcripts location `~/.claude/projects/<slug>` (or `$CLAUDE_CONFIG_DIR/projects/<slug>`) plus the legacy repo-local one: upstream only.
- RESOLVED: runs.json also holds one campaign-level row per campaign with campaign-level work: upstream only.
- RESOLVED: description says the orchestrator dispatches sub-agents, never the Workflow tool; the workflow script sections are replaced by direct dispatch: both sides made the same change.

## Conflicts

- RESOLVED: "Dispatch rules are the same as / are those of mission-execution": wording only; upstream's taken.
- ESCALATED: what counts as green: local "0 failed, 0 xfailed, and no skip without a stated environmental reason; an xfail or a bare skip is a parked defect, not a pass; fixed in code or test unless the user explicitly signs it off"; upstream "0 failed, 0 xfailed or todo, and no skip without a stated environmental reason; an xfail, a todo or a bare skip is a parked defect, not a pass; same fix-or-sign-off rule"; question should a `todo` test block the mission gate (upstream's rule), or only failed, xfailed and bare-skipped tests as local has it?
