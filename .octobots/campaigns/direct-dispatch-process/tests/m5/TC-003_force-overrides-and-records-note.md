---
id: TC-003
title: "--force flips the m10 copy and appends the dated override note"
mission: M5
covers: [M5-AC1]
kind: cli
status: draft
priority: high
size: S
---

# TC-003: --force flips the m10 copy and appends the dated override note

**Mission:** M5 | **Priority:** high | **Kind:** cli | **Covers:** M5-AC1

## Objective

--force flips the m10 copy and appends the dated override note. Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots epic-013 m10 (same record as TC-001)

## Commands

```bash
M=$WORK/solo-octobots/campaigns/epic-013-ruleset-and-interval-retention/missions/m10-setup-flow-preset-and-exception-authorization
node $PACK/skill/mission-planner/scripts/set-status.js $M "$(grep -m1 '^name:' $M/mission.yaml | cut -c7-)" active --force; echo "exit=$?"
grep -n "status:\|Plan review overridden" $M/mission.yaml
node $PACK/skill/mission-planner/scripts/validate.js $M; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run set-status.js ... active --force | Exit 0; status active |
| 2 | Read notes | A `## Plan review overridden (YYYY-MM-DD)` section was appended; prior notes preserved verbatim |
| 3 | validate.js on the result | No new error |

## Expected Final State

Override works and is recorded on the board.
