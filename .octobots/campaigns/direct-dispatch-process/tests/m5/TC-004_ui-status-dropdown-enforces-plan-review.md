---
id: TC-004
title: "Extension status dropdown refuses active without a plan review and shows a confirm dialog"
mission: M5
covers: [M5-AC2]
kind: ui
status: draft
priority: critical
size: L
---

# TC-004: Extension status dropdown refuses active without a plan review and shows a confirm dialog

**Mission:** M5 | **Priority:** critical | **Kind:** ui | **Covers:** M5-AC2

## Objective

Extension status dropdown refuses active without a plan review and shows a confirm dialog. Verifies M5-AC2 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

a copy of solo's `.octobots` opened as the workspace in the Dev Host, mission epic-013 m10 (draft, no plan review); then uwb m3 (campaign has a plan review)

## Commands

```bash
# automated half (BoardHost over the real copy, stubbed window):
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/vscode-extension test -- board-host-plan-review
# manual half: F5 on $OCTO, open the workspace containing the solo copy; Screenshots to tests/m5/evidence/.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | In the mission panel for epic-013 m10 choose status `active` in the dropdown | A modal confirm dialog names the missing plan review and offers Continue/Cancel; status unchanged until confirmed |
| 2 | Cancel | Status stays draft; no file change |
| 3 | Repeat and confirm | Status becomes active; notes gain `## Plan review overridden (<date>)` |
| 4 | On uwb m3 (campaign has a satisfying plan review) set active | Flips with no dialog |
| 5 | Run the host unit test | Green; same verdicts as the pack function on the shared table |

## Expected Final State

UI enforcement matches the script. UI half recorded as MANUAL (not Playwright-drivable).
