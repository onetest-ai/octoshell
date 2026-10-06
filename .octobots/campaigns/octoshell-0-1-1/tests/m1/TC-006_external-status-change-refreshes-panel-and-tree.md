---
id: TC-006
title: "An agent's set-test-status.js write updates the open panel and the tree; the extension writes nothing; a deleted TC says so"
mission: M1
covers: [M1-AC5]
kind: ui
status: draft
priority: critical
size: M
---

# TC-006: An agent's set-test-status.js write updates the open panel and the tree; the extension writes nothing; a deleted TC says so

**Mission:** M1 | **Priority:** critical | **Kind:** ui | **Covers:** M1-AC5

## Objective

With the panel open, a status recorded by an agent in a terminal reaches the panel, the leaf, its mission group and the Tests node through the board watcher, with no write and no reload loop from the extension.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.
- The manual half runs in an Extension Development Host (F5) and is recorded as manual, with screenshots under `tests/m1/evidence/`.

## Real data (pre-existing record)

$DDP/tests/m6/TC-004_sidebar-tests-node-counts.md (blocked) and its sibling RUN file RUN-2026-10-06-002.md (exists) in the F5 workspace $WORK/octo-ws; $DDP/tests/m6/TC-003_malformed-tc-warns-not-errors.md (copy) for the deletion step.

## Commands

```bash
# automated half (spine refresh, deleted state; watcher debounce at most one rebuild)
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/test-case-view.test.tsx test/board-watcher.test.ts --reporter=verbose
# manual half: F5 on $WORK/octo-ws with TC-004's panel open and the Tests > m6 group expanded
node $SET $DDP/tests/m6/TC-004_sidebar-tests-node-counts.md fail --evidence .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-002.md --date 2026-10-07
shasum $DDP/tests/m6/TC-004_sidebar-tests-node-counts.md   # right after the script, and again 10 s later
rm $DDP/tests/m6/TC-003_malformed-tc-warns-not-errors.md      # with TC-003's panel open (step 5)
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run test-case-view.test.tsx and board-watcher.test.ts | At least 1 test passed in each, 0 failed |
| 2 | F5: open TC-004's panel; note the m6 group label and icon | Panel shows blocked; group label counts as on disk |
| 3 | Run the script (fail, RUN-2026-10-06-002, 2026-10-07) in a terminal | Within a few seconds the panel shows fail, last run 2026-10-07 linking RUN-2026-10-06-002.md; the leaf shows the fail icon and word; the m6 group and Tests node counts gain one fail and lose one blocked and their icon turns to the failed colour (M6 B1) |
| 4 | Compare the two shasums (right after the script, 10 s later) | Equal: the extension wrote nothing |
| 5 | Open TC-003's panel, then rm the file | The panel shows `This test case no longer exists`, with no dropdown; no error notification |

## Expected Final State

External writes are reflected everywhere without a write or a reload loop from the extension, and a vanished TC degrades to a clear state. Live half recorded as manual.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
