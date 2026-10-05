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

Solo's real pytest suite as of commit f2e7812d^ (extracted read-only with `git archive`), which contains `edgeserver/tests/test_m6_solve_over_the_wire_e2e.py:474 pytest.xfail(` (an imperative xfail with a reason string), plus today's solo `edgeserver/tests` (0 parked markers on 2026-10-05).

## Commands

```bash
mkdir -p $WORK/solo-hist && git -C $SOLO archive f2e7812d^ edgeserver/tests | tar -x -C $WORK/solo-hist
cd $WORK/solo-hist && git init -q && git add -A          # scan-parked lists files with git ls-files
node $PACK/skill/mission-execution/scripts/scan-parked.js --root edgeserver/tests --json | jq -c '.unsigned'
node $PACK/skill/mission-execution/scripts/scan-parked.js --root edgeserver/tests >/dev/null; echo "history exit=$?"
grep -rnE 'pytest\.(xfail|skip)\(|@pytest\.mark\.(xfail|skip)([^a-z_]|$)' edgeserver/tests | head -20     # independent cross-check
cd $SOLO && node $PACK/skill/mission-execution/scripts/scan-parked.js --root edgeserver/tests --json | jq -c '{unsigned: (.unsigned|length), allowed: (.allowed|length)}'   # today's tree, read-only
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Scan the f2e7812d^ extraction | `.unsigned` includes edgeserver/tests/test_m6_solve_over_the_wire_e2e.py line 474 (`pytest.xfail(`); exit 1 |
| 2 | Cross-check with the independent grep | Same set of hits (QA explains any difference) |
| 3 | Scan today's solo tree (read-only) | 0 unsigned (recorded 2026-10-05); exit 0 |
| 4 | Optional pytest -rxs cross-check | Counts consistent, or recorded 'not run' |

## Expected Final State

The scan finds the real historical xfail and agrees with today's clean suite.
