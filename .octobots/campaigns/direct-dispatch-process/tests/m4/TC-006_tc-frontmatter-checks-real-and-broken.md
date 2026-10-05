---
id: TC-006
title: "validate.js on a real uwb TC passes frontmatter checks; a copy whose id mismatches its filename warns"
mission: M4
covers: [M4-AC3]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m4/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-006: validate.js on a real uwb TC passes frontmatter checks; a copy whose id mismatches its filename warns

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC3

## Objective

validate.js on a real uwb TC passes frontmatter checks; a copy whose id mismatches its filename warns. Verifies M4-AC3 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

real solo uwb m1 `TC-003_set-ranging-mode-persists.md` (legacy frontmatter: `requirements: [M1-AC2, M1-AC5]`, `type: functional`, extra keys priority/module/size/tags), and two copies of it: `TC-097_id-mismatch.md` (still `id: TC-003`) and `TC-003_nosection.md` (no `## Expected Final State`; named TC-003 so its filename prefix matches its `id: TC-003`)

## Commands

```bash
T=$WORK/solo-octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m1
node $PACK/skill/mission-planner/scripts/validate.js $T/TC-003_set-ranging-mode-persists.md; echo "exit=$?"
cp $T/TC-003_set-ranging-mode-persists.md $T/TC-097_id-mismatch.md           # frontmatter keeps id: TC-003
node $PACK/skill/mission-planner/scripts/validate.js $T/TC-097_id-mismatch.md; echo "exit=$?"
awk '/^## Expected Final State/{exit} {print}' $T/TC-003_set-ranging-mode-persists.md > $T/TC-003_nosection.md   # prefix TC-003 = id TC-003, so ONLY the section warning fires
node $PACK/skill/mission-planner/scripts/validate.js $T/TC-003_nosection.md; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Validate the real TC-003 file | Exit 0; no id/mission/covers/section warnings (legacy `requirements: [M1-AC2, M1-AC5]` accepted as covers; the extra keys and `type` are ignored) |
| 2 | Validate TC-097_id-mismatch.md (frontmatter `id: TC-003`) | Exit 0; one warning that the frontmatter id TC-003 does not match the filename prefix TC-097 |
| 3 | Validate TC-003_nosection.md | Exit 0; one warning naming the missing `## Expected Final State` section |

## Expected Final State

Format problems are warnings; the real file is clean.

## Teardown

- `rm $T/TC-097_id-mismatch.md $T/TC-003_nosection.md` before TC-007, so the broken copies do not enter the parity inputs.

## Case text correction (T4.5, 2026-10-06)

Step 3 originally built the missing-section copy as `TC-098_nosection.md` while the awk copy kept `id: TC-003`, so validate.js (correctly) also warned `id TC-003 does not match the filename prefix TC-098`: 2 warnings, not the 1 the step expected. The product was right and the case text wrong (T4.2 QA found it). The copy is now named `TC-003_nosection.md`, so the filename prefix matches the id and the missing section is the only defect. The expectation (exactly one warning, naming the section) is unchanged.
