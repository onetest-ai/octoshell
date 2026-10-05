---
id: TC-003
title: "A malformed TC is a warning in validateBoard and validate.js, never an error"
mission: M6
covers: [M6-AC2, M6-AC7]
kind: unit
status: draft
priority: high
size: M
---

# TC-003: A malformed TC is a warning in validateBoard and validate.js, never an error

**Mission:** M6 | **Priority:** high | **Kind:** unit | **Covers:** M6-AC2, M6-AC7

## Objective

A malformed TC is a warning in validateBoard and validate.js, never an error. Verifies M6-AC2 and M6-AC7 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copies of real TC files from this campaign and from solo uwb m1, each broken one way (bad YAML, status: passing, kind: manual, id mismatch) — a synthetic unit check by definition, derived from real files

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/board test -- test-cases-malformed
cp $OCTO/.octobots/campaigns/direct-dispatch-process/tests/m1/TC-001_*.md $WORK/ && sed -i '' 's/^status: draft/status: passing/' $WORK/TC-001_*.md
node $PACK/skill/mission-planner/scripts/validate.js $WORK/TC-001_*.md; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Break a real TC in each of four ways and validate with both implementations | Four `warning` findings per implementation with identical text; no error; validate.js exit 0 |
| 2 | List them through the board library | Still listed (with their problems), not dropped |

## Expected Final State

Warnings only; parity holds.
