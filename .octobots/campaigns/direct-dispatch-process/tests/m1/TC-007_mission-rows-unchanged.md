---
id: TC-007
title: "uwb M1-M6 mission rows are identical before and after"
mission: M1
covers: [M1-AC5]
kind: cli
status: draft
priority: critical
size: S
---

# TC-007: uwb M1-M6 mission rows are identical before and after

**Mission:** M1 | **Priority:** critical | **Kind:** cli | **Covers:** M1-AC5

## Objective

uwb M1-M6 mission rows are identical before and after. Verifies M1-AC5 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo's real runs.json mission rows for uwb-ranging-ingest-vendor-v01 M1..M6 (pre-existing, committed baseline)

## Commands

```bash
cd $SOLO/.claude/worktrees/qa-m1
cp $SOLO/.octobots/tokenomics/runs.json $WORK/runs.before.json    # committed baseline
node $PACK/tokenomics/collect.mjs --project-dir "$PWD" && node $PACK/tokenomics/rollup.mjs
jq -S '[.runs[]?|select(.campaign|test("uwb-ranging")) |select(.mission!=null)]' $WORK/runs.before.json > $WORK/a.json
jq -S '[.runs[]?|select(.campaign|test("uwb-ranging")) |select(.mission!=null)]' .octobots/tokenomics/runs.json > $WORK/b.json
diff $WORK/a.json $WORK/b.json && echo MISSION_ROWS_IDENTICAL
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Save solo's committed runs.json as the baseline | Baseline saved |
| 2 | Rerun collect + rollup with the v57 pack in the worktree | Exit 0 |
| 3 | Diff the uwb mission rows (mission != null), sorted | No difference. Only the new campaign-level (mission: null) rows may differ |

## Expected Final State

Mission rows are byte-identical; campaign-level attribution only adds campaign rows. If cost differs because new transcripts accrued since the baseline, QA re-runs the baseline with the OLD pack on the same worktree and diffs old-pack vs new-pack (state this in the run report).
