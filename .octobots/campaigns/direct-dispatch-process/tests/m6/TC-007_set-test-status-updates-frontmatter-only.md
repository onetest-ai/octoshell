---
id: TC-007
title: "set-test-status.js changes only status/last_run; body byte-identical; idempotent; invalid input exits 2"
mission: M6
covers: [M6-AC6]
kind: cli
status: draft
priority: critical
size: M
---

# TC-007: set-test-status.js changes only status/last_run; body byte-identical; idempotent; invalid input exits 2

**Mission:** M6 | **Priority:** critical | **Kind:** cli | **Covers:** M6-AC6

## Objective

set-test-status.js changes only status/last_run; body byte-identical; idempotent; invalid input exits 2. Verifies M6-AC6 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copies of a real new-frontmatter TC from this campaign and a real legacy TC (uwb m1 TC-003)

## Commands

```bash
T=$WORK/TC-copy.md; cp $OCTO/.octobots/campaigns/direct-dispatch-process/tests/m1/TC-001_*.md $T
node $PACK/skill/mission-planner/scripts/set-test-status.js $T pass --evidence tests/m1/runs/RUN-2026-10-05-001.md --date 2026-10-05; echo "exit=$?"
diff <(sed '1,/^---$/{/^---$/!d}' $T | sed '1,/^---$/d') <(sed '1,/^---$/d' $OCTO/.octobots/campaigns/direct-dispatch-process/tests/m1/TC-001_*.md | sed '1,/^---$/d') && echo BODY_IDENTICAL
cp $T $T.1; node $PACK/skill/mission-planner/scripts/set-test-status.js $T pass --evidence tests/m1/runs/RUN-2026-10-05-001.md --date 2026-10-05; cmp $T $T.1 && echo IDEMPOTENT
node $PACK/skill/mission-planner/scripts/set-test-status.js $T passing; echo "exit=$?  (expect 2)"
node $PACK/skill/mission-planner/scripts/set-test-status.js $OCTO/README.md pass; echo "exit=$?  (expect 2)"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Set status pass with evidence and date on a copy | Exit 0; frontmatter has `status: pass` and `last_run` with the date and evidence path |
| 2 | Diff the body | Byte-identical |
| 3 | Run the same command again | No change (idempotent) |
| 4 | Invalid status; non-TC path | Exit 2 each, file unchanged |

## Expected Final State

Only the two frontmatter keys change.
