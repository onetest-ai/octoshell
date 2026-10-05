---
id: TC-002
title: "set-status.js active on a uwb mission whose campaign notes hold '## Plan review (Alex + Rio, 2026-10-02)': allowed"
mission: M5
covers: [M5-AC1]
kind: cli
status: draft
priority: critical
size: S
---

# TC-002: set-status.js active on a uwb mission whose campaign notes hold '## Plan review (Alex + Rio, 2026-10-02)': allowed

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC1

## Objective

set-status.js active on a uwb mission whose campaign notes hold '## Plan review (Alex + Rio, 2026-10-02)': allowed. Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb campaign (real notes with the plan review) and a mission copy set back to draft

## Commands

```bash
C=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01
grep -n -A4 "^  ## Plan review" $C/campaign.yaml | head -12
M=$C/missions/m3-range-trilateration-to-position-records
node $PACK/skill/mission-planner/scripts/set-status.js $M "$(grep -m1 '^name:' $M/mission.yaml | cut -c7-)" draft
node $PACK/skill/mission-planner/scripts/set-status.js $M "$(grep -m1 '^name:' $M/mission.yaml | cut -c7-)" active; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Read the real campaign notes' plan review section | Section exists; record exactly what Reviewers/Verdict lines (if any) it contains (see README A1) |
| 2 | Reset the mission copy to draft and set it active | Exit 0 and status active, no override note appended |

## Expected Final State

A satisfying real review in the CAMPAIGN notes permits the flip.
