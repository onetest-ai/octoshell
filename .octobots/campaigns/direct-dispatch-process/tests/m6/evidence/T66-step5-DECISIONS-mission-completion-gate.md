# mission-completion-gate: reconcile against pack v57

## Kept local

- RESOLVED: project instance of the lanes: upstream's generic "read the declared test lanes" rule is taken; local's commands (`make edgeserver-test-fast`, `make edgeserver-test` / `make coverage`, `-n auto --cov`) follow it as this project's instance. AGENTS.md declares no lanes yet.

## Taken from upstream

- RESOLVED: description, version marker, "Do not use the Workflow tool" gate section, dispatch rules, relay rules, phases 2-5 and the verdict shapes: local and upstream made the same change.
- RESOLVED: Sage names the pre-existing record "where the project's CLAUDE.md / AGENTS.md asks for one": upstream generalises local's "(see CLAUDE.md)".
- RESOLVED: the hook-fires-only-on-a-real-transition note, "QA on the test cases" section, phase 5 ticking wording, tokenomics transcript locations and campaign rows in runs.json: upstream only.

## Conflicts

- ESCALATED: what counts as green (parked tests, the parked-test scan and the verdict's parked counts): local green means 0 failed, 0 xfailed and no skip without a stated environmental reason, with no scan; upstream green means 0 failed, 0 xfailed or todo and no skip without a stated environmental reason, plus a mandatory `scan-parked.js --json` run (exit 1 on any unsigned parked test blocks phase 1, sign-offs only by the user in `.octobots/parked-signoff.txt`) and `parked` counts in the verdict; question should `todo` tests and the `scan-parked.js` check block phase 1 (upstream), or only failed, xfailed and bare skips (local)?
