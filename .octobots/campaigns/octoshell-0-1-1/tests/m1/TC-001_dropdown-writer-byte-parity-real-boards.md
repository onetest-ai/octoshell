---
id: TC-001
title: "Dropdown writer and set-test-status.js write identical bytes on every real TC and every settable status"
mission: M1
covers: [M1-AC3, M1-AC11]
kind: unit
status: draft
priority: critical
size: M
---

# TC-001: Dropdown writer and set-test-status.js write identical bytes on every real TC and every settable status

**Mission:** M1 | **Priority:** critical | **Kind:** unit | **Covers:** M1-AC3, M1-AC11

## Objective

The board library's TC status writer (T1.1) is a port of the pack's set-test-status.js; this case proves the two write the same bytes, or refuse alike, over every real test case of octoshell's and solo's boards and every status the dropdown can set, so a status picked in the panel is indistinguishable on disk from one an agent recorded.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

Every TC-*.md under tests/m<n>/ of the copies $WORK/octo-ws/.octobots (this repo: direct-dispatch-process m1..m7, 86 TCs with real last_run lines, one with an extra `note:` key in last_run: m7 TC-007) and $WORK/solo-ws/.octobots (solo: uwb m1..m6, 119 legacy TCs). Spot record: $DDP/tests/m6/TC-004_sidebar-tests-node-counts.md.

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/octo-ws/.octobots:$WORK/solo-ws/.octobots" pnpm --filter @octoshell/board exec vitest run test/tc-status-parity.test.ts --reporter=verbose
# independent spot check outside the vitest: both writers on two copies of the same real file
F=campaigns/direct-dispatch-process/tests/m6/TC-004_sidebar-tests-node-counts.md
mkdir -p $WORK/p1 $WORK/p2 && cp -R $WORK/octo-ws/.octobots $WORK/p1/ && cp -R $WORK/octo-ws/.octobots $WORK/p2/
node $SET $WORK/p1/.octobots/$F pass --date 2026-10-06
node --input-type=module -e 'const b = await import(process.argv[1]); console.log(JSON.stringify(b.writeTestCaseStatus(process.argv[2], process.argv[3], { status: "pass", date: "2026-10-06" })))' $OCTO/packages/board/dist/index.js $WORK/p2/.octobots $F
cmp $WORK/p1/.octobots/$F $WORK/p2/.octobots/$F && echo IDENTICAL
# draft/ready take no --date (the script refuses it there, set-test-status.js:85)
G=campaigns/direct-dispatch-process/tests/m6/TC-001_parse-own-campaign-tests.md
node $SET $WORK/p1/.octobots/$G ready
node --input-type=module -e 'const b = await import(process.argv[1]); console.log(JSON.stringify(b.writeTestCaseStatus(process.argv[2], process.argv[3], { status: "ready", date: null })))' $OCTO/packages/board/dist/index.js $WORK/p2/.octobots $G
cmp $WORK/p1/.octobots/$G $WORK/p2/.octobots/$G && echo IDENTICAL-READY
diff $WORK/octo-ws/.octobots/$F $WORK/p2/.octobots/$F
awk 'c>=2{print} /^---$/{c++}' $WORK/octo-ws/.octobots/$F | shasum; awk 'c>=2{print} /^---$/{c++}' $WORK/p2/.octobots/$F | shasum
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run tc-status-parity.test.ts over both board copies | At least 1 test passed, 0 failed; the verbose output names both board copies, shows TCs compared from each, and reports 0 script refusals over real (TC, status) pairs (pass/fail/blocked with --date, draft/ready without; only statuses different from the file's) |
| 2 | Run the script on copy p1 and the TS writer on copy p2 for TC-004, status pass, date 2026-10-06 | The script prints `status pass, last_run 2026-10-06`; the TS writer returns ok with changed true |
| 3 | cmp the two files | `IDENTICAL` |
| 4 | diff the original against p2 | Only the `status:` line (blocked -> pass) and the `last_run:` line (now `last_run: {date: 2026-10-06}`, the old evidence gone) differ |
| 5 | Compare the body hashes (awk) of original and p2 | Equal |
| 6 | Run both writers with ready (no --date) on TC-001 of m6 | `IDENTICAL-READY`; last_run untouched |

## Expected Final State

Zero byte differences between the two writers over every real TC and status; the body of a written TC is byte-identical to before; a dropdown pass records the date only, with no evidence.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
