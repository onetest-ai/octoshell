---
id: TC-002
title: "add-tests.js on solo uwb m1 (README exists, doc linked): no change, exit 0"
mission: M4
covers: [M4-AC1]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m4/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-002: add-tests.js on solo uwb m1 (README exists, doc linked): no change, exit 0

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC1

## Objective

add-tests.js on solo uwb m1 (README exists, doc linked): no change, exit 0. Verifies M4-AC1 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb `m1-venue-ingest-mode-and-vendor-integer-ids` (real README with 10 mapped ACs, document already linked)

## Commands

```bash
C=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01
cp -R $C $WORK/uwb.before
node $PACK/skill/mission-planner/scripts/add-tests.js $C/missions/m1-venue-ingest-mode-and-vendor-integer-ids; echo "exit=$?"
git diff --no-index --stat $WORK/uwb.before $C && echo NO_CHANGE
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Snapshot the campaign, run add-tests.js on m1 | Exit 0 |
| 2 | `git diff --no-index` before vs after | No difference: the existing README is not overwritten, the document is not duplicated (idempotent on target) |
| 3 | Run it a second time | Still no change, exit 0 |

## Expected Final State

Idempotent; never overwrites a real README.
