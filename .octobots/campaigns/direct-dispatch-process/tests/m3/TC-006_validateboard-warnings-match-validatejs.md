---
id: TC-006
title: "validateBoard on the solo copy: 6 warnings, 0 workflow errors, same text as validate.js"
mission: M3
covers: [M3-AC3]
kind: unit
status: fail
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m3/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-006: validateBoard on the solo copy: 6 warnings, 0 workflow errors, same text as validate.js

**Mission:** M3 | **Priority:** high | **Kind:** unit | **Covers:** M3-AC3

## Objective

validateBoard on the solo copy: 6 warnings, 0 workflow errors, same text as validate.js. Verifies M3-AC3 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots (6 real workflows/ folders)

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/board exec vitest run test/validate-workflows-warning.test.ts --reporter=verbose
node $PACK/skill/mission-planner/scripts/validate.js $WORK/solo-octobots/campaigns/sensor-assignment-uplift/missions/m2-player-role-on-the-edge-match-roster-read-only | grep '^warning:'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate-workflows-warning.test.ts on the copy (validateBoard) | At least 1 test passed; 6 findings with severity "warning" (one per workflows/<slug>/ folder; a workflows/ with no sub-folder counts as one), each message `<path relative to the board root, /-separated>: no longer read since pack v57`; 0 findings of severity error that mention a workflow |
| 2 | For the sensor-assignment-uplift m2 folder, compare the finding's message with the validate.js warning line | `warning: ` + the finding message is identical to the validate.js line; across the whole copy, the set of validateBoard warnings equals the union of validate.js warning lines over every campaign dir |

## Expected Final State

Warnings only, with message parity between the two implementations.
