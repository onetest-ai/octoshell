---
id: TC-004
title: "validate.js on uwb m2: warning that M2-AC10 is not covered by any test case"
mission: M4
covers: [M4-AC2]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m4/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-004: validate.js on uwb m2: warning that M2-AC10 is not covered by any test case

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC2

## Objective

validate.js on uwb m2: warning that M2-AC10 is not covered by any test case. Verifies M4-AC2 of M4 - Functional test cases are a gate-run unit of every mission.

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
| 1 | Run validate.js on m2 | One warning naming M2-AC10 as not covered by any test case (AC index per the real board); exit code 0 |

## Expected Final State

Warning only.
