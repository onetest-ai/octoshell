---
id: TC-008
title: "BoardModel on the uwb copy: entity counts unchanged with tests/m1..m6, runs/ and evidence/ present"
mission: M4
covers: [M4-AC6]
kind: unit
status: draft
priority: high
size: S
---

# TC-008: BoardModel on the uwb copy: entity counts unchanged with tests/m1..m6, runs/ and evidence/ present

**Mission:** M4 | **Priority:** high | **Kind:** unit | **Covers:** M4-AC6

## Objective

BoardModel on the uwb copy: entity counts unchanged with tests/m1..m6, runs/ and evidence/ present. Verifies M4-AC6 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb campaign with its real tests/m1..m6 (hundreds of TC files, runs/, evidence/)

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/board test -- tests-folder-ignored
# plus: touch a file under tests/m1/runs/ and evidence/ while the watcher is running, assert exactly one debounced reload
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Load the board with and without the tests/ folder | Identical campaign/mission/task/bug counts |
| 2 | Write files under tests/m1/runs and evidence while the watcher is attached | No entity appears; no reconcile loop beyond the existing debounce (one reload at most) |

## Expected Final State

tests/ is invisible to the entity model.
