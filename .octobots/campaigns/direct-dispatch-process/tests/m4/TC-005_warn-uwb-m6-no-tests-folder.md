---
id: TC-005
title: "validate.js on uwb m6 (done, no README, no TCs): warning, not error"
mission: M4
covers: [M4-AC2]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m4/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-005: validate.js on uwb m6 (done, no README, no TCs): warning, not error

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC2

## Objective

validate.js on uwb m6 (done, no README, no TCs): warning, not error. Verifies M4-AC2 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb `m6-receiver-port-configuration-file` (real: done, tests/m6 has only runs/ and evidence/)

## Commands

```bash
M=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/missions/m6-receiver-port-configuration-file
node $PACK/skill/mission-planner/scripts/validate.js $M; echo "exit=$?"
ls $WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m6
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate.js on m6 | A `warning:` that the mission has no linked tests README / no TCs; exit code 0; never an error |

## Expected Final State

Warning, exit unchanged.
