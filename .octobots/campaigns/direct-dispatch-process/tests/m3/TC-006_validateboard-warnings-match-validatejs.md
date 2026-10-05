---
id: TC-006
title: "validateBoard on the solo copy: 6 warnings, 0 workflow errors, same text as validate.js"
mission: M3
covers: [M3-AC3]
kind: unit
status: draft
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
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/board test -- validate-workflows-warning
node $PACK/skill/mission-planner/scripts/validate.js $WORK/solo-octobots/campaigns/sensor-assignment-uplift/missions/m2-player-role-on-the-edge-match-roster-read-only | grep '^warning:'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validateBoard on the copy | 6 findings with severity "warning" (one per workflows/ folder); 0 findings of severity error that mention a workflow |
| 2 | For the sensor-assignment-uplift m2 folder, compare the finding's message with the validate.js warning line | Identical text |

## Expected Final State

Warnings only, with message parity between the two implementations.
