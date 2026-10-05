---
id: TC-004
title: "validate.js on uwb m2: warning 'M2-AC10 is not mapped'"
mission: M4
covers: [M4-AC2]
kind: cli
status: draft
priority: high
size: S
---

# TC-004: validate.js on uwb m2: warning 'M2-AC10 is not mapped'

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC2

## Objective

validate.js on uwb m2: warning 'M2-AC10 is not mapped'. Verifies M4-AC2 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb `m2-tcp-range-set-ingest-with-ack-and-de-duplicatio` (10 real ACs, README maps 9)

## Commands

```bash
M=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/missions/m2-tcp-range-set-ingest-with-ack-and-de-duplicatio
node $PACK/skill/mission-planner/scripts/validate.js $M; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate.js on m2 | One warning naming M2-AC10 as not mapped (AC index per the real board); exit code 0 |

## Expected Final State

Warning only.
