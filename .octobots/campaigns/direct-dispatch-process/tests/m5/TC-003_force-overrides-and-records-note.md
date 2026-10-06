---
id: TC-003
title: "--force=<reason> flips solo M10 into executing from any argv position and records the override; the overridden note never satisfies a later check; bare --force exits 2"
mission: M5
covers: [M5-AC1]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-003: --force=<reason> flips solo M10 into executing from any argv position and records the override; the overridden note never satisfies a later check; bare --force exits 2

**Mission:** M5 | **Priority:** high | **Kind:** cli | **Covers:** M5-AC1

## Objective

The override works and is recorded on the board, and the record it leaves is not itself a review. Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies. Use a fresh copy of the campaign so TC-001's moves do not matter: `cp -R $SOLO/.octobots/campaigns/epic-013-ruleset-and-interval-retention $WORK/e13-tc3`.

## Real data (pre-existing record)

solo epic-013 M10 (the same record as TC-001: draft, no plan review in the mission or campaign notes).

## Commands

```bash
C=$WORK/e13-tc3; M=$C/missions/m10-setup-flow-preset-and-exception-authorization
N="M10 - One setup flow, preset warnings, and edge-side exception authorization"
SS=$PACK/skill/mission-planner/scripts/set-status.js
node $SS $C "$N" executing --force; echo "bare exit=$?"
node $SS $C "$N" executing "--force=QA override for TC-003"; echo "last-position exit=$?"
grep -n "^status:" $M/mission.yaml; grep -n -A1 "## Plan review overridden (" $M/mission.yaml
node $SS $C "$N" draft > /dev/null; node $SS $C "$N" executing; echo "again exit=$?"
node $SS "--force=first position" $C "$N" executing; echo "first-position exit=$?"
node $SS $C "$N" draft > /dev/null; node $SS $C "--force=middle position" "$N" executing; echo "middle-position exit=$?"
grep -c "## Plan review overridden (" $M/mission.yaml
node $PACK/skill/mission-planner/scripts/validate.js $M; echo "validate exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | `executing --force` without a reason | Exit 2 (usage: --force needs a reason); file unchanged |
| 2 | `--force=<reason>` as the last argument | Exit 0; `status: executing`; the notes end with `## Plan review overridden (<today UTC>)` followed by the reason; earlier notes preserved verbatim |
| 3 | Back to draft, then a plain move into executing | Exit 3: the overridden note does not satisfy the rule |
| 4 | `--force=` in the first and in the middle argv position | Both exit 0; 3 overridden notes in total |
| 5 | validate.js on the mission | No new error |

## Expected Final State

The override flips the status and leaves a dated record with its reason; that record never counts as a review.
