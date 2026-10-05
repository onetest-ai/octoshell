---
id: TC-003
title: "BoardModel on a copy of solo's board: entity ids equal the pre-change set minus workflow ids"
mission: M3
covers: [M3-AC2]
kind: cli
status: draft
priority: critical
size: M
---

# TC-003: BoardModel on a copy of solo's board: entity ids equal the pre-change set minus workflow ids

**Mission:** M3 | **Priority:** critical | **Kind:** cli | **Covers:** M3-AC2

## Objective

BoardModel on a copy of solo's board: entity ids equal the pre-change set minus workflow ids. Verifies M3-AC2 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots (copy of solo's real board incl. 6 workflows/ folders)

## Commands

```bash
Q=$OCTO/apps/vscode-extension/scripts/qa/dump-ids.mjs           # committed harness (T3.3); prints sorted "<kind><TAB><id>" lines
node $Q $WORK/solo-octobots --board-dist $WORK/main-build/packages/board/dist/index.js > $WORK/ids.before   # main (pre-M3) library: incl. workflow ids
node $Q $WORK/solo-octobots > $WORK/ids.after                                                                # mission-branch library
grep -v '^workflow' $WORK/ids.before | sort > $WORK/a; sort $WORK/ids.after > $WORK/b; diff $WORK/a $WORK/b && echo IDS_IDENTICAL
grep -c '^workflow' $WORK/ids.after   # 0
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Dump entity ids with main's board library (--board-dist) over the solo copy | Ids list incl. 6 workflow ids |
| 2 | Dump ids with the M3 build | No workflow ids |
| 3 | Diff before (minus workflow ids) with after | Identical: every campaign, mission, task and bug id unchanged |

## Expected Final State

No entity was lost or renamed; no workflow entity exists.
