---
id: TC-008
title: "A single click on a TC leaf or a mission-panel TC row opens its panel (once), not the file; Open source file opens the file; the panel survives a reload"
mission: M1
covers: [M1-AC6]
kind: ui
status: draft
priority: critical
size: S
---

# TC-008: A single click on a TC leaf or a mission-panel TC row opens its panel (once), not the file; Open source file opens the file; the panel survives a reload

**Mission:** M1 | **Priority:** critical | **Kind:** ui | **Covers:** M1-AC6

## Objective

The click behaviour the user asked for (decision 2: sidebar; decision 4: mission panel rows), with one panel per TC and correct restore after a window reload.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.
- The manual half runs in an Extension Development Host (F5) and is recorded as manual, with screenshots under `tests/m1/evidence/`.

## Real data (pre-existing record)

The Tests node of this repo's direct-dispatch-process campaign in $WORK/octo-ws (m6 TC-004 and TC-005); for step 6, the copy of $DDP/tests/m6/TC-005_mission-panel-tests-and-ac-coverage.md.

## Commands

```bash
# automated half
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/campaigns-tree-tests.test.ts test/test-case-panel.test.ts test/panel-restore-activation.test.ts test/mission-tests-panel.test.tsx --reporter=verbose
# manual half: F5 on $WORK/octo-ws
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the four test files | At least 1 test passed in each, 0 failed |
| 2 | F5: single-click the TC-004 leaf | The TC-004 panel opens; no editor tab for TC-004_sidebar-tests-node-counts.md appears |
| 3 | Click another tab, then single-click the TC-004 leaf again | The same panel tab is focused; still exactly one TC-004 panel tab |
| 4 | Click Open source file | The raw markdown opens in a text editor |
| 5 | Developer: Reload Window | The TC-004 panel is restored with its content, no `no editor registered` or other error |
| 6 | Open TC-005's panel, close the window's panels except it, rm the TC-005 copy, Developer: Reload Window | The restored panel shows `This test case no longer exists`; no error |
| 7 | Open the M6 mission panel and click the TC-004 row in its Tests section | The TC-004 panel is revealed (the same tab, no duplicate); no editor tab opens on the raw file (decision 4) |

## Expected Final State

One click opens one panel per TC; the raw file is one button away; panels restore cleanly. Live half recorded as manual.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
