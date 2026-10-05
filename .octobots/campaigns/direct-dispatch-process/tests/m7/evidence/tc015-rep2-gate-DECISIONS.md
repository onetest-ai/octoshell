# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: repo-specific lane commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`): upstream's generic "project's fast lane / coverage lane" rule taken, local commands kept right after it as this project's instance.
- RESOLVED: "see `CLAUDE.md`" for the pre-existing record: upstream's conditional wording taken, local's pointer kept as this project's instance.

## Taken from upstream

- RESOLVED: hook fires only on a real transition to `done` (note under the hook description): upstream only.
- RESOLVED: "are those of `mission-execution` § Dispatch rules" wording and the removed blank line: wording only.
- RESOLVED: transcript locations (`~/.claude/projects/<slug>`, `$CLAUDE_CONFIG_DIR`, legacy repo-local): upstream only.
- RESOLVED: `runs.json` campaign-level rows: upstream only.
- RESOLVED: new "Gate timing" section: upstream only.

## Conflicts

- RESOLVED (user, 2026-10-05): what counts as green: keep local; 0 xfailed blocks the merge.
