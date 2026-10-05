# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: test lanes: upstream's generic rule (read the declared lanes, brief by name) is taken; local's concrete commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`) are kept right after it as this project's instance.

## Taken from upstream

- RESOLVED: hook fires only on a real transition to `done`: upstream only; taken.
- RESOLVED: transcript locations (`~/.claude/projects/<slug>`, `$CLAUDE_CONFIG_DIR`, legacy repo-local): upstream only; taken.
- RESOLVED: `runs.json` campaign-level rows: upstream only; taken.
- RESOLVED: Sage and Rio talk through the orchestrator's relay; no Workflow tool, one sub-agent per phase; mission-execution cross-reference: both sides made the same change; taken.
- RESOLVED: "Dispatch rules are those of mission-execution": wording only; taken.

## Conflicts

- RESOLVED: pre-existing record Sage names: local pointed at `CLAUDE.md`; upstream says "where the project's `CLAUDE.md` / `AGENTS.md` asks for one". Same rule, upstream's is the general form and covers local's file; not a policy difference. Upstream wording taken.
- ESCALATED: what counts as green: local 0 failed, 0 xfailed, and no skip without a stated environmental reason; upstream 0 failed, 0 xfailed or todo, and no skip without a stated environmental reason (a `todo` is also a parked defect); question should a `todo` block the gate (upstream) or not (local)?
