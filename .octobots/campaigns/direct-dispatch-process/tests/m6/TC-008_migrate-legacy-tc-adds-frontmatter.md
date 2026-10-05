---
id: TC-008
title: "set-test-status.js --migrate adds the missing frontmatter to a real legacy uwb TC"
mission: M6
covers: [M6-AC6, M6-AC2]
kind: cli
status: draft
priority: high
size: M
---

# TC-008: set-test-status.js --migrate adds the missing frontmatter to a real legacy uwb TC

**Mission:** M6 | **Priority:** high | **Kind:** cli | **Covers:** M6-AC6, M6-AC2

## Objective

set-test-status.js --migrate adds the missing frontmatter to a real legacy uwb TC. Verifies M6-AC6 and M6-AC2 of M6 - Test cases are first-class on the board.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copy of real uwb m1 `TC-003_set-ranging-mode-persists.md` (legacy: `requirements: [M1-AC2, M1-AC5]`, `type: functional`, no status/kind/mission)

## Commands

```bash
T=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m1/TC-003_set-ranging-mode-persists.md; cp $T $WORK/legacy.orig
node $PACK/skill/mission-planner/scripts/set-test-status.js $T --migrate; echo "exit=$?"
awk 'NR>1 && /^---$/{exit} NR>1' $T                                          # the new frontmatter
awk 'c>=2{print} /^---$/{c++}' $WORK/legacy.orig > $WORK/legacy.body; awk 'c>=2{print} /^---$/{c++}' $T > $WORK/migrated.body
cmp $WORK/legacy.body $WORK/migrated.body && echo BODY_IDENTICAL
node $PACK/skill/mission-planner/scripts/validate.js $T | grep -ci migrate   # 0: suggestion gone
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run `--migrate` (no status) on the legacy copy | Exit 0; frontmatter now has id TC-003, title from the H1, mission M1, covers [M1-AC2, M1-AC5] (from requirements), status unknown; kind from the type/steps heuristic or omitted; the legacy keys (priority, module, size, tags, type) kept |
| 2 | Body diff | Identical |
| 3 | Revalidate | The migrate suggestion is gone; no error |

## Expected Final State

Legacy file upgraded without touching the body.
