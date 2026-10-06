---
id: TC-010
title: "scan-parked.js on octoshell: exit 0, vault-calibration.test.ts:10 listed as allowed"
mission: M5
covers: [M5-AC6]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
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

The real octoshell repo: one real parked test, packages/graph/test/vault-calibration.test.ts:10 `describe.skipIf(!HAS_VAULT)` (allowed), and packages/graph/bin/octograph.mjs:30 `process.exit(` (the false-positive trap for a naive `xit(` pattern). Step 4's probe file is a copy of the real test file with one `it.skip(` added, in a throwaway clone (a synthetic negative control, derived from a real file).

## Commands

```bash
cd $OCTO && node $PACK/skill/mission-execution/scripts/scan-parked.js; echo "exit=$?"
node $PACK/skill/mission-execution/scripts/scan-parked.js --json | jq -c '.allowed[]|select(.file|test("vault-calibration"))'
node $PACK/skill/mission-execution/scripts/scan-parked.js --json | jq -c '[.unsigned[], .allowed[]]|map(select(.file|test("octograph[.]mjs")))'
git clone -q $OCTO $WORK/octo-clone && cd $WORK/octo-clone
awk '{print} NR==1{print "it.skip(\"parked by a QA probe\", () => {});"}' packages/graph/test/vault-calibration.test.ts > packages/graph/test/qa-parked-probe.test.ts && git add packages/graph/test/qa-parked-probe.test.ts
node $PACK/skill/mission-execution/scripts/scan-parked.js --json | jq -c '.unsigned'; node $PACK/skill/mission-execution/scripts/scan-parked.js >/dev/null; echo "exit=$?"
L=$(grep -n 'it.skip' packages/graph/test/qa-parked-probe.test.ts | cut -d: -f1); mkdir -p .octobots && echo "packages/graph/test/qa-parked-probe.test.ts:$L qa-engineer 2026-10-05" >> .octobots/parked-signoff.txt
node $PACK/skill/mission-execution/scripts/scan-parked.js >/dev/null; echo "exit after signoff=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run scan-parked.js at the octoshell root | Exit 0 |
| 2 | Read the allowed list | Lists packages/graph/test/vault-calibration.test.ts line 10 as allowed (skipIf); no unsigned hit |
| 3 | Look for octograph.mjs in either list | `[]`: `process.exit(` is not a hit |
| 4 | In a throwaway clone, add a git-tracked copy of the test with `it.skip(` and rerun | Exit 1; `.unsigned` lists qa-parked-probe.test.ts with its line |
| 5 | Add a `<path>:<line> <who> <date>` line to .octobots/parked-signoff.txt and rerun | Exit 0: the signoff exempts the hit |

## Expected Final State

0 unsigned on octoshell; the one real skipIf is allowed; process.exit( is ignored; an unsigned skip fails the scan until signed off. Teardown: `rm -rf $WORK/octo-clone`.
