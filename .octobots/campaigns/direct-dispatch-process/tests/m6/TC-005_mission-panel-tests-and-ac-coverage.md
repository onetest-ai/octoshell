---
id: TC-005
title: "Mission panel: Tests section and AC coverage with uncovered ACs highlighted"
mission: M6
covers: [M6-AC4]
kind: ui
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md}
priority: critical
size: L
---

# TC-005: Mission panel: Tests section and AC coverage with uncovered ACs highlighted

**Mission:** M6 | **Priority:** critical | **Kind:** ui | **Covers:** M6-AC4

## Objective

Mission panel: Tests section and AC coverage with uncovered ACs highlighted. Verifies M6-AC4 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo uwb `m1-venue-ingest-mode-and-vendor-integer-ids` (real: 11 ACs; one AC is covered by no TC frontmatter/alias at the gap); this campaign's M6 (all ACs covered); octoshell octograph m6 (no tests: empty state)

## Commands

```bash
# automated half (component test over real copies):
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/octo-octobots:$WORK/solo-octobots" pnpm --filter @octoshell/vscode-extension exec vitest run test/mission-tests-panel.test.tsx --reporter=verbose
# manual: F5, open the three mission panels, screenshots.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 0 | Run mission-tests-panel.test.tsx | At least 1 test passed |
| 1 | Open uwb m1's mission panel | Tests section lists the TCs with status `unknown`; AC coverage lists M1-AC1..AC11 with their covering TCs and M1-AC11 highlighted in warning style (not error style) as uncovered |
| 2 | Open this campaign's M6 panel | Every AC has covering TCs; no highlight |
| 3 | Open octograph m6 | Empty state with the `add-tests.js` hint, no crash |

## Expected Final State

The real uncovered AC is surfaced as a warning. MANUAL for the live panel.
