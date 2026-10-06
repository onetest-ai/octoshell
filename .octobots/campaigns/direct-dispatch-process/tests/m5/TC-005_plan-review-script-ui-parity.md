---
id: TC-005
title: "Pack plan-review.mjs and @octoshell/board planReviewStatus agree on the shared table and every real notes pair of both boards"
mission: M5
covers: [M5-AC1, M5-AC2]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
priority: high
size: M
---

# TC-005: Pack plan-review.mjs and @octoshell/board planReviewStatus agree on the shared table and every real notes pair of both boards

**Mission:** M5 | **Priority:** high | **Kind:** unit | **Covers:** M5-AC1, M5-AC2

## Objective

One rule, two implementations, no drift between the script and the UI. Verifies M5-AC1 and M5-AC2 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Every (mission notes, campaign notes) pair in the copies of the solo and octoshell boards (real notes). On 2026-10-05 the rule spike found solo: 115 missions, 6 allowed (the uwb missions, legacy, through the campaign notes); this campaign: 6 of 6 allowed (strict).

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/solo-octobots:$WORK/octo-octobots" pnpm --filter @octoshell/board exec vitest run test/plan-review-parity.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the parity test | At least 1 test passed, none failed: identical {ok, legacy, heading, where, candidates} from both implementations for the shared table and for every real pair |
| 2 | Read the satisfied pairs it lists | Solo: only uwb-ranging-ingest-vendor-v01 missions, each legacy, through the campaign notes. Octoshell: this campaign's missions, strict, through the campaign notes. This campaign's M5 notes alone are not satisfying (self-approval check) |

## Expected Final State

The script and the UI rule cannot drift.
