# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: lane commands in the tests+coverage phase: upstream's generic "read the declared lanes" rule taken; local's `make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov` kept right after it as this project's instance.

## Taken from upstream

- RESOLVED: hook note that the gate fires only on a real transition to `done`: upstream only.
- RESOLVED: "Dispatch rules are those of ...": wording only.
- RESOLVED: pre-existing record "where the project's CLAUDE.md / AGENTS.md asks for one": generic form of local's "(see CLAUDE.md)"; this project's CLAUDE.md is still the pointer.
- RESOLVED: transcript locations in Tokenomics capture, and the campaign-level `runs.json` rows: upstream only.
- RESOLVED: new "Gate timing" section: upstream only.

## Conflicts

- RESOLVED (user, 2026-10-05): what counts as green: keep local; 0 xfailed blocks the merge. Local's rule kept (0 failed, 0 xfailed, no skip without a stated environmental reason).
