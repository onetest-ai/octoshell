---
id: TC-004
title: "Activation leaves every file under the 11 real workflows/ folders byte-identical"
mission: M3
covers: [M3-AC2]
kind: unit
status: draft
priority: critical
size: M
---

# TC-004: Activation leaves every file under the 11 real workflows/ folders byte-identical

**Mission:** M3 | **Priority:** critical | **Kind:** unit | **Covers:** M3-AC2

## Objective

Activation leaves every file under the 11 real workflows/ folders byte-identical. Verifies M3-AC2 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

11 real workflows/ folders (5 octoshell + 6 solo) in the copies, sha256 baseline $WORK/wf.before

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/solo-octobots:$WORK/octo-octobots" pnpm --filter @octoshell/vscode-extension exec vitest run test/activation-workflows-untouched.test.ts --reporter=verbose
find $WORK/solo-octobots $WORK/octo-octobots -path '*/workflows/*' -type f -exec shasum -a 256 {} + | sort > $WORK/wf.after; diff $WORK/wf.before $WORK/wf.after && echo UNTOUCHED
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the suite: it activates BoardHost (as the extension does at startup) over both copies | At least 1 test passed; no error; no migration runs |
| 2 | Recompute sha256 of every file under any workflows/ folder | Identical to the baseline (UNTOUCHED), no file added or removed |

## Expected Final State

Activation never writes under workflows/ (migrateLegacyWorkflows is gone).
