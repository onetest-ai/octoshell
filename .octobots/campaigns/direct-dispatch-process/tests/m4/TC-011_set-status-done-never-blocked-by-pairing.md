---
id: TC-011
title: "set-status.js done on a mission with unmapped ACs and no tests folder succeeds"
mission: M4
covers: [M4-AC2]
kind: cli
status: draft
priority: critical
size: S
---

# TC-011: set-status.js done on a mission with unmapped ACs and no tests folder succeeds

**Mission:** M4 | **Priority:** critical | **Kind:** cli | **Covers:** M4-AC2

## Objective

set-status.js done on a mission with unmapped ACs and no tests folder succeeds. Verifies M4-AC2 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb m6 (no README, no TCs) and uwb m1 (AC11 unmapped); both copies

## Commands

```bash
C=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01
for m in "m6-receiver-port-configuration-file:M6 - Receiver port configuration file" "m1-venue-ingest-mode-and-vendor-integer-ids:M1 - Venue ingest mode and vendor integer ids"; do
  d=${m%%:*}; n=${m#*:}
  node $PACK/skill/mission-planner/scripts/set-status.js $C "$n" active >/dev/null
  node $PACK/skill/mission-planner/scripts/set-status.js $C "$n" done; echo "exit=$?"
  grep -n "^status:" $C/missions/$d/mission.yaml
done
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Move each copy to active then done with `set-status.js <campaign-dir> "<title>" <state>` (on a build with M5's gate, the active move needs M5's override) | exit 0 both times and mission.yaml reads `status: done`; the pairing warning never blocks |

## Expected Final State

Pairing never blocks a status flip.
