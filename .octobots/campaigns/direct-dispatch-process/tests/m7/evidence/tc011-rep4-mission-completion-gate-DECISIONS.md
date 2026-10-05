# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: project test commands: local names this project's lane commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`); upstream's generic "read the project's declared test lanes" rule is taken and local's commands are kept right after it as this project's instance.

## Taken from upstream

- RESOLVED: frontmatter description, relay wording for Rio/Sage, "Do not use the Workflow tool", orchestrator-dispatch gate and removal of the Workflow template: both sides made the same change.
- RESOLVED: dispatch rules wording ("those of" vs "the same as"): same meaning; upstream's text taken.
- RESOLVED: hook fires only on a real transition to done note: upstream only.
- RESOLVED: transcripts location (`~/.claude/projects/<slug>`, `$CLAUDE_CONFIG_DIR`): upstream only.
- RESOLVED: runs.json campaign-level rows: upstream only.
- RESOLVED: mission-execution cross-reference wording: both sides made the same change.

## Conflicts

- RESOLVED: Sage names the backing record: local says "(see `CLAUDE.md`)", upstream says "where the project's `CLAUDE.md` / `AGENTS.md` asks for one". Not policy; upstream's wording covers local's reference and is generic. Upstream taken.
- ESCALATED: what counts as green: local "0 failed, 0 xfailed, and no skip without a stated environmental reason" (an xfail or bare skip is a parked defect); upstream "0 failed, 0 xfailed or todo, and no skip without a stated environmental reason" (an xfail, a todo or a bare skip is a parked defect); question should a `todo` test also block the mission gate (upstream), or only failed, xfailed and unexplained skips (local)?
