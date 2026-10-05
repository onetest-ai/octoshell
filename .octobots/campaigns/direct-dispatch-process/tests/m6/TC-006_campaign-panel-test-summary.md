---
id: TC-006
title: "Campaign panel: test summary totals by status and uncovered AC count"
mission: M6
covers: [M6-AC5]
kind: ui
status: draft
priority: high
size: M
---

# TC-006: Campaign panel: test summary totals by status and uncovered AC count

**Mission:** M6 | **Priority:** high | **Kind:** ui | **Covers:** M6-AC5

## Objective

Campaign panel: test summary totals by status and uncovered AC count. Verifies M6-AC5 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo uwb campaign (real: 6 missions, gaps at m1 AC11 and m2 AC10, m6 without tests) and this campaign

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/octo-octobots:$WORK/solo-octobots" pnpm --filter @octoshell/vscode-extension exec vitest run test/campaign-tests-summary.test.tsx --reporter=verbose
# manual: F5, open both campaign panels.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 0 | Run campaign-tests-summary.test.tsx | At least 1 test passed |
| 1 | Open the solo uwb campaign panel | Totals by status (unknown for legacy) equal the sum of per-mission counts; uncovered AC count includes M1-AC11 and M2-AC10 (and every AC of m6) |
| 2 | Click a mission row | Opens that mission's panel |
| 3 | Open this campaign's panel | Totals match the TC files; uncovered AC count 0 |

## Expected Final State

Summary equals the data. MANUAL for the live panel.
