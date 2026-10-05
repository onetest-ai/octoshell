---
id: TC-006
title: "doctor.js on a copy of solo: one warn for 6 workflows/ folders, overall status not failed by it"
mission: M2
covers: [M2-AC4]
kind: cli
status: draft
priority: high
size: S
---

# TC-006: doctor.js on a copy of solo: one warn for 6 workflows/ folders, overall status not failed by it

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC4

## Objective

doctor.js on a copy of solo: one warn for 6 workflows/ folders, overall status not failed by it. Verifies M2-AC4 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo (copy of solo's real board: 6 workflows/ folders)

## Commands

```bash
cd $WORK/solo && node .claude/skills/mission-planner/scripts/doctor.js --json > $WORK/doctor.json; echo "exit=$?"
jq '.checks[]|select(.name|test("workflow";"i"))' $WORK/doctor.json
find $WORK/solo/.octobots -type d -name workflows | wc -l
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Count workflows/ folders in the copy | 6 (recorded 2026-10-05) |
| 2 | Run doctor.js | Exactly one check about workflows with status `warn` (never `fail`), message contains the count and the fix (git rm -r or keep as history) |
| 3 | Check overall status/exit code | Not failed because of this check |

## Expected Final State

One warn naming the count (6) and the fix.
