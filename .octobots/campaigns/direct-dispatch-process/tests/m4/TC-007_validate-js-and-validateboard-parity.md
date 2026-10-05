---
id: TC-007
title: "validateBoard and validate.js emit identical pairing/TC messages"
mission: M4
covers: [M4-AC2, M4-AC3]
kind: unit
status: draft
priority: high
size: M
---

# TC-007: validateBoard and validate.js emit identical pairing/TC messages

**Mission:** M4 | **Priority:** high | **Kind:** unit | **Covers:** M4-AC2, M4-AC3

## Objective

validateBoard and validate.js emit identical pairing/TC messages. Verifies M4-AC2 and M4-AC3 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb m1, m2, m6 and a real TC (same inputs as TC-003..006)

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/board exec vitest run test/validate-tests-parity.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate-tests-parity.test.ts: both implementations over the same real inputs, comparing message text (paths relative to .octobots/) and severity | At least 1 test passed; identical sets (all `warning`), incl. the README-map disagreement and TC format cases |

## Expected Final State

No drift between validate.js and validate.ts.
