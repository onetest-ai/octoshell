---
id: TC-011
title: "scan-parked.js on solo edgeserver/tests lists the real xfail/skip with path:line"
mission: M5
covers: [M5-AC6]
kind: cli
status: draft
priority: high
size: M
---

# TC-011: scan-parked.js on solo edgeserver/tests lists the real xfail/skip with path:line

**Mission:** M5 | **Priority:** high | **Kind:** cli | **Covers:** M5-AC6

## Objective

scan-parked.js on solo edgeserver/tests lists the real xfail/skip with path:line. Verifies M5-AC6 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo `edgeserver/tests` (real pytest suite; M1 notes recorded 1 xfailed, M6 recorded 0; QA reports whatever exists now)

## Commands

```bash
cd $SOLO && node $PACK/skill/mission-execution/scripts/scan-parked.js --root edgeserver/tests --json | jq '.unsigned, .allowed'
grep -rnE 'xfail|pytest\.mark\.skip\b|pytest\.skip\(' edgeserver/tests | head -20     # independent cross-check
# optional (cheap lane only): cd $SOLO/edgeserver && make edgeserver-test-fast ... | grep -E 'xfailed|skipped'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run scan-parked.js against solo's tests (read-only) | Reports every xfail/skip marker lacking reason= with path:line; skipif-with-reason listed as allowed |
| 2 | Cross-check with an independent grep | Same set of hits (QA explains any difference) |
| 3 | Optional pytest -rxs cross-check | Counts consistent, or recorded 'not run' |

## Expected Final State

Scan agrees with the real suite's parked tests.
