---
id: TC-001
title: "set-status.js refuses to move solo's draft M10 (no plan review anywhere) into executing: exit 3, file byte-identical; ungated moves pass"
mission: M5
covers: [M5-AC1]
kind: cli
status: draft
priority: critical
size: S
---

# TC-001: set-status.js refuses to move solo's draft M10 (no plan review anywhere) into executing: exit 3, file byte-identical; ungated moves pass

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC1

## Objective

A move into executing is refused without a recorded plan review, under every spelling that maps to executing. Moves to the other states are never gated (campaign decision 11). Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots epic-013-ruleset-and-interval-retention, mission `m10-setup-flow-preset-and-exception-authorization` ('M10 - One setup flow, preset warnings, and edge-side exception authorization', status draft). Neither the mission notes nor the campaign notes hold a `## Plan review` section (0 matches on 2026-10-05).

## Commands

```bash
C=$WORK/solo-octobots/campaigns/epic-013-ruleset-and-interval-retention
M=$C/missions/m10-setup-flow-preset-and-exception-authorization
N="M10 - One setup flow, preset warnings, and edge-side exception authorization"
SS=$PACK/skill/mission-planner/scripts/set-status.js
grep -c "## Plan review" $M/mission.yaml $C/campaign.yaml
shasum -a 256 $M/mission.yaml > $WORK/m10.sha
for st in executing active "in progress" running; do
  node $SS $C "$N" $st 2> $WORK/tc1.err; echo "$st exit=$?"; head -3 $WORK/tc1.err
  shasum -a 256 -c $WORK/m10.sha > /dev/null && echo "  unchanged"
done
for st in "awaiting approval" draft cancelled draft; do node $SS $C "$N" $st > /dev/null; echo "$st exit=$?"; done
node $SS $C "$N" done; echo "draft->done exit=$?"; grep -n "^status:" $M/mission.yaml
node $SS $C "$N" draft > /dev/null; node $SS $C "$N" failed; echo "draft->failed exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Count plan-review headings in the mission and campaign files | 0 and 0 |
| 2 | Move into executing with each of executing, active, in progress, running | Each exits 3; stderr says no plan review is recorded in the mission or campaign notes and names how to record one or use `--force=<reason>`; mission.yaml unchanged after each |
| 3 | Move to awaiting approval, then draft, cancelled, draft | Each exits 0 (never gated) |
| 4 | draft -> done, then draft -> failed | Both exit 0 and the status changes (decision 11: only moves into executing are gated) |

## Expected Final State

Every move into executing is refused with an unchanged file; moves to the other states pass.
