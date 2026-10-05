---
id: TC-008
title: "BoardModel ignores tests/; the watcher skips runs/ and evidence/ but rebuilds once on a TC write"
mission: M4
covers: [M4-AC6]
kind: unit
status: draft
priority: high
size: S
---

# TC-008: BoardModel ignores tests/; the watcher skips runs/ and evidence/ but rebuilds once on a TC write

**Mission:** M4 | **Priority:** high | **Kind:** unit | **Covers:** M4-AC6

## Objective

BoardModel ignores tests/; the watcher skips runs/ and evidence/ but rebuilds once on a TC write. Verifies M4-AC6 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo-octobots uwb campaign with its real tests/m1..m6 (hundreds of TC files, runs/, evidence/)

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES=$WORK/solo-octobots pnpm --filter @octoshell/board exec vitest run test/tests-folder-ignored.test.ts --reporter=verbose
pnpm --filter @octoshell/vscode-extension exec vitest run test/board-watcher.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run tests-folder-ignored.test.ts over the uwb copy (board with and without tests/) | At least 1 test passed; identical entity ids |
| 2 | Run board-watcher.test.ts: writes under tests/m1/runs/ and tests/m1/evidence/ | At least 1 test passed; no rebuild is triggered |
| 3 | Same suite: a write to tests/m1/TC-*.md | Exactly one debounced rebuild (no reconcile loop) |

## Expected Final State

tests/ is invisible to the entity model; runs/ and evidence/ writes cost nothing; TC/README writes refresh the board once (M6 relies on it).
