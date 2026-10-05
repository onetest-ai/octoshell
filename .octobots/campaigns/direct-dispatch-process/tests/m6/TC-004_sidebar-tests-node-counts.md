---
id: TC-004
title: "Sidebar Tests node: grouped by mission with status counts; click opens the TC"
mission: M6
covers: [M6-AC3]
kind: ui
status: draft
priority: critical
size: L
---

# TC-004: Sidebar Tests node: grouped by mission with status counts; click opens the TC

**Mission:** M6 | **Priority:** critical | **Kind:** ui | **Covers:** M6-AC3

## Objective

Sidebar Tests node: grouped by mission with status counts; click opens the TC. Verifies M6-AC3 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

this campaign (direct-dispatch-process, new frontmatter) and solo's uwb campaign (legacy, 100+ TCs, m1 with AC11 gap) in the Dev Host; octoshell octograph (no tests) as the negative

## Commands

```bash
# automated half:
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/octo-octobots:$WORK/solo-octobots" pnpm --filter @octoshell/vscode-extension exec vitest run test/campaigns-tree-tests.test.ts --reporter=verbose
# manual half: F5; screenshots to tests/m6/evidence/.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 0 | Run campaigns-tree-tests.test.ts | At least 1 test passed |
| 1 | Expand the direct-dispatch-process campaign | A `Tests` node exists, with child groups m1..m6 labelled with counts equal to the TC files on disk (e.g. `m2 · 12 · 12 draft` on 2026-10-05) |
| 2 | After QA flips some TCs, reopen | Counts reflect pass/fail/blocked (`30✓ 1✗ 1 blocked` style) |
| 3 | Expand the solo uwb campaign | Tests node with m1..m6; legacy TCs counted under unknown; m6 shows 0 or is omitted |
| 4 | Expand octoshell's octograph campaign | No Tests node (no TCs) |
| 5 | Click a TC leaf | The TC markdown opens in the editor |

## Expected Final State

Counts match the files; click opens. Recorded as MANUAL for the live tree; the unit half runs over real copies.
