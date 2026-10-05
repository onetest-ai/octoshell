---
id: TC-006
title: "validate.js on a real uwb TC passes frontmatter checks; a copy with id TC-999 warns"
mission: M4
covers: [M4-AC3]
kind: cli
status: draft
priority: high
size: S
---

# TC-006: validate.js on a real uwb TC passes frontmatter checks; a copy with id TC-999 warns

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC3

## Objective

validate.js on a real uwb TC passes frontmatter checks; a copy with id TC-999 warns. Verifies M4-AC3 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

real solo uwb m1 `TC-003_set-ranging-mode-persists.md` (legacy `requirements:` frontmatter), and a copy of it with `id: TC-999`

## Commands

```bash
T=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m1
node $PACK/skill/mission-planner/scripts/validate.js $T/TC-003_set-ranging-mode-persists.md; echo "exit=$?"
sed 's/^id: TC-003/id: TC-999/' $T/TC-003_set-ranging-mode-persists.md > $T/TC-999_broken.md
node $PACK/skill/mission-planner/scripts/validate.js $T/TC-999_broken.md; echo "exit=$?"
sed '/^## Expected Final State/,$d' $T/TC-003_set-ranging-mode-persists.md > $T/TC-998_nosection.md
node $PACK/skill/mission-planner/scripts/validate.js $T/TC-998_nosection.md; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Validate the real TC-003 file | No id/mission/covers/section warnings (legacy `requirements: [M1-AC3]` accepted as covers) |
| 2 | Validate the copy with id: TC-999 (filename TC-999_broken.md would match, so keep the filename TC-003-like if the check keys on filename: QA states which) | A warning that the frontmatter id does not match the filename / is not a TC of this mission |
| 3 | Validate the copy without `## Expected Final State` | A warning naming the missing section |

## Expected Final State

Format problems are warnings; the real file is clean.
