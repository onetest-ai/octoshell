---
id: TC-009
title: "Dogfood: QA records this mission's own results with set-test-status.js and the board shows them"
mission: M6
covers: [M6-AC6, M6-AC3, M6-AC4]
kind: ui
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md}
priority: critical
size: M
---

# TC-009: Dogfood: QA records this mission's own results with set-test-status.js and the board shows them

**Mission:** M6 | **Priority:** critical | **Kind:** ui | **Covers:** M6-AC6, M6-AC3, M6-AC4

## Objective

Dogfood: QA records this mission's own results with set-test-status.js and the board shows them. Verifies M6-AC6 and M6-AC3 and M6-AC4 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

this mission's own TC files (tests/m6/TC-*.md), run by the QA task on the mission branch

## Commands

```bash
# for each executed TC:
node $PACK/skill/mission-planner/scripts/set-test-status.js $OCTO/.octobots/campaigns/direct-dispatch-process/tests/m6/TC-0NN_*.md <pass|fail|blocked> --evidence tests/m6/runs/RUN-<date>-001.md
# then in the Dev Host (watcher running): observe the sidebar counts and the M6 mission panel update without a reload.
git -C $OCTO diff --stat -- .octobots/campaigns/direct-dispatch-process/tests/m6
git -C $OCTO diff -U0 -- .octobots/campaigns/direct-dispatch-process/tests/m6 | grep '^[-+][^-+]' | grep -v -E '^[-+](status|last_run|  date|  evidence):' | wc -l     # 0: only frontmatter status/last_run lines changed
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Execute TC-001..008 and TC-010 and record each result with set-test-status.js | Each TC's frontmatter shows status and last_run with the RUN file path |
| 2 | With the Dev Host open, watch the Tests node and the M6 panel while the writes happen | Counts and statuses update via the watcher within one debounce per write; no reload loop; no error notification |
| 3 | Check the diff | Only status/last_run frontmatter lines changed in tests/m6 TC files (the count printed is 0) |
| 4 | Check the gate/QA skill text | Instructs calling set-test-status.js for every TC run |

## Expected Final State

The board reflects the QA run. MANUAL for the live reflection.
