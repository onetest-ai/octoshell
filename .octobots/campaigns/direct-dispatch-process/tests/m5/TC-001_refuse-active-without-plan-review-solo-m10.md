---
id: TC-001
title: "set-status.js active on solo epic-013 M10 (no plan review anywhere): exit 1, file unchanged"
mission: M5
covers: [M5-AC1]
kind: cli
status: draft
priority: critical
size: S
---

# TC-001: set-status.js active on solo epic-013 M10 (no plan review anywhere): exit 1, file unchanged

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC1

## Objective

set-status.js active on solo epic-013 M10 (no plan review anywhere): exit 1, file unchanged. Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots epic-013 `m10-setup-flow-preset-and-exception-authorization` (real draft mission; neither mission nor campaign notes hold a plan review)

## Commands

```bash
M=$WORK/solo-octobots/campaigns/epic-013-ruleset-and-interval-retention/missions/m10-setup-flow-preset-and-exception-authorization
grep -c "^## Plan review" $M/mission.yaml $WORK/solo-octobots/campaigns/epic-013-ruleset-and-interval-retention/campaign.yaml
shasum -a 256 $M/mission.yaml > $WORK/m10.sha
node $PACK/skill/mission-planner/scripts/set-status.js $M "$(grep -m1 '^name:' $M/mission.yaml | cut -c7-)" active; echo "exit=$?"
shasum -a 256 -c $WORK/m10.sha
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Confirm no plan review exists in the mission or campaign notes | 0 matches in both |
| 2 | Run set-status.js ... active | Exit 1; stderr names the missing plan review and how to record it / --force |
| 3 | Verify the file | sha256 unchanged |

## Expected Final State

Refused; nothing written.
