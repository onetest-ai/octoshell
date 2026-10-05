---
id: TC-005
title: "Pack planReviewStatus and board planReviewStatus agree on every real notes block"
mission: M5
covers: [M5-AC1, M5-AC2]
kind: unit
status: draft
priority: high
size: M
---

# TC-005: Pack planReviewStatus and board planReviewStatus agree on every real notes block

**Mission:** M5 | **Priority:** high | **Kind:** unit | **Covers:** M5-AC1, M5-AC2

## Objective

Pack planReviewStatus and board planReviewStatus agree on every real notes block. Verifies M5-AC1 and M5-AC2 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

every mission+campaign `notes` block in the copies of the solo and octoshell boards (real notes, not synthesised)

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/solo-octobots:$WORK/octo-octobots" pnpm --filter @octoshell/board test -- plan-review-parity
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run both functions over every real notes pair and compare verdicts | Identical for all pairs; the test lists which pairs are satisfied (expected: uwb, whatever else carries a plan review) |

## Expected Final State

No drift between script and UI rule.
