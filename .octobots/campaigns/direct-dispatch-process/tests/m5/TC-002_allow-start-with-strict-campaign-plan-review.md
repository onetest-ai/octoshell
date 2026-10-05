---
id: TC-002
title: "This campaign's strict plan-review record lets its draft M6 move into executing with no warning"
mission: M5
covers: [M5-AC1]
kind: cli
status: draft
priority: critical
size: S
---

# TC-002: This campaign's strict plan-review record lets its draft M6 move into executing with no warning

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC1

## Objective

A strict record (column-0 `Reviewers:` with the tokens ba and tech-lead, and `Verdict: approved with nits`) in the CAMPAIGN notes permits the move, and prints no legacy warning. Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.
- M6 of this campaign is still draft on the copy (it is when M5 is QA'd). If it is not, record the stored status and use another draft mission of this campaign.

## Real data (pre-existing record)

$WORK/octo-octobots direct-dispatch-process campaign notes: `## Plan review (Alex + Rio, 2026-10-05)` with `Reviewers: ba (Alex), tech-lead (Rio)` and `Verdict: approved with nits` (recorded 2026-10-05). The mission is 'M6 - Test cases are first-class on the board'.

## Commands

```bash
C=$WORK/octo-octobots/campaigns/direct-dispatch-process
M=$C/missions/m6-test-cases-are-first-class-on-the-board
grep -n -A3 "^  ## Plan review (" $C/campaign.yaml
grep -n "^status:" $M/mission.yaml
node $PACK/skill/mission-planner/scripts/set-status.js $C "M6 - Test cases are first-class on the board" executing 2> $WORK/tc2.err; echo "exit=$?"
test -s $WORK/tc2.err && cat $WORK/tc2.err || echo "stderr empty"
grep -n "^status:" $M/mission.yaml; grep -c "Plan review overridden" $M/mission.yaml
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Read the campaign's plan-review section | The heading, then column-0 `Reviewers: ba (Alex), tech-lead (Rio)` and `Verdict: approved with nits` (2-space indented in the YAML block, which is column 0 in the notes) |
| 2 | Move M6 into executing | Exit 0; `stderr empty` (no legacy warning) |
| 3 | Read M6 | `status: executing`; 0 overridden notes |

## Expected Final State

A strict campaign-level record allows the start silently.
