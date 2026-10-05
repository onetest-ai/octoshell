---
id: TC-003
title: "validate.js on uwb m1: warning that M1-AC11 is not covered by any test case, exit code unchanged"
mission: M4
covers: [M4-AC2]
kind: cli
status: draft
priority: critical
size: S
---

# TC-003: validate.js on uwb m1: warning that M1-AC11 is not covered by any test case, exit code unchanged

**Mission:** M4 | **Priority:** critical | **Kind:** cli | **Covers:** M4-AC2

## Objective

validate.js on uwb m1: warning that M1-AC11 is not covered by any test case, exit code unchanged. Verifies M4-AC2 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb m1: real 11 ACs; neither the README map nor any TC frontmatter covers M1-AC11 (real gap)

## Commands

```bash
C=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01
M=$C/missions/m1-venue-ingest-mode-and-vendor-integer-ids
node $PACK/skill/mission-planner/scripts/validate.js $M; echo "exit=$?"
for st in draft active done; do node $PACK/skill/mission-planner/scripts/set-status.js $C "M1 - Venue ingest mode and vendor integer ids" $st; echo "set-status exit=$?"; node $PACK/skill/mission-planner/scripts/validate.js $M | grep "M1-AC11"; done
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate.js on the real m1 (current status done) | Exactly one `warning:` naming M1-AC11 as not covered by any test case; exit code 0 (as the entity alone) |
| 2 | Set the copy to draft, active, done in turn (`set-status.js <campaign-dir> "<title>" <state>`) and revalidate | set-status exit 0 every time; the warning appears at every status and is never an error |

## Expected Final State

A warning at every status; never an error; done never blocked.
