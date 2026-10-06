---
id: TC-003
title: "A malformed TC is a warning in validateBoard and validate.js, never an error"
mission: M6
covers: [M6-AC2, M6-AC7]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md}
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
cd $OCTO && pnpm --filter @octoshell/board exec vitest run test/test-cases-malformed.test.ts test/validate-tc-parity.test.ts --reporter=verbose
T=$WORK/octo-octobots/campaigns/direct-dispatch-process/tests/m1/TC-001_collect-reads-home-slug-dir.md
awk '{ if ($0=="status: draft") print "status: passing"; else print }' $T > $T.tmp && mv $T.tmp $T
node $PACK/skill/mission-planner/scripts/validate.js $T; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two suites (each breaks real TCs four ways: bad YAML, status: passing, kind: manual, id mismatch, and validates with both implementations) | At least 1 test passed in each; four `warning` findings per implementation with identical text; no error |
| 1b | validate.js on the copied TC with `status: passing` | Exit 0; one warning naming the invalid status |
| 2 | List them through the board library | Still listed (with their problems), not dropped |

## Expected Final State

Warnings only; parity holds.
