---
id: TC-010
title: "scan-parked.js on octoshell: exit 0, vault-calibration.test.ts:10 listed as allowed"
mission: M5
covers: [M5-AC6]
kind: cli
status: draft
priority: critical
size: S
---

# TC-010: scan-parked.js on octoshell: exit 0, vault-calibration.test.ts:10 listed as allowed

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC6

## Objective

scan-parked.js on octoshell: exit 0, vault-calibration.test.ts:10 listed as allowed. Verifies M5-AC6 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real octoshell repo (one real parked test: packages/graph/test/vault-calibration.test.ts:10 describe.skipIf(!HAS_VAULT))

## Commands

```bash
cd $OCTO && node $PACK/skill/mission-execution/scripts/scan-parked.js; echo "exit=$?"
node $PACK/skill/mission-execution/scripts/scan-parked.js --json | jq '.allowed[]|select(.file|test("vault-calibration"))'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run scan-parked.js at the octoshell root | Exit 0 |
| 2 | Read the allowed list | Lists packages/graph/test/vault-calibration.test.ts:10 as allowed (skipIf with an environmental reason); no unsigned hit |
| 3 | Add a copy of the file with `.skip(` and no signoff in a temp clone and rerun | Exit 1 listing the unsigned hit (then discard the clone) |

## Expected Final State

0 unsigned; the one real skipIf is allowed.
