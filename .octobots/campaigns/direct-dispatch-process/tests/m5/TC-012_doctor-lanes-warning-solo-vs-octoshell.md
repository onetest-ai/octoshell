---
id: TC-012
title: "doctor.js lanes warning on solo's AGENTS.md copy and none on octoshell's"
mission: M5
covers: [M5-AC7]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-012: doctor.js lanes warning on solo's AGENTS.md copy and none on octoshell's

**Mission:** M5 | **Priority:** high | **Kind:** cli | **Covers:** M5-AC7

## Objective

doctor.js lanes warning on solo's AGENTS.md copy and none on octoshell's. Verifies M5-AC7 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copies of the real AGENTS.md of solo (no `## Test lanes` section) and of octoshell (declares fast:/coverage:)

## Commands

```bash
for r in solo octo; do
  SRC=$( [ $r = solo ] && echo $SOLO || echo $OCTO ); BOARD=$( [ $r = solo ] && echo $WORK/solo-octobots || echo $WORK/octo-octobots )
  mkdir -p $WORK/d-$r && cp $SRC/AGENTS.md $WORK/d-$r/ && cp -R $BOARD $WORK/d-$r/.octobots
  (cd $WORK/d-$r && node $PACK/skill/mission-planner/scripts/doctor.js --json | jq -c '.findings[]|select(.area=="lanes")')
done
grep -n -A6 "^## Test lanes" $OCTO/AGENTS.md
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | doctor.js --json on the solo copy | One finding `{level: "warn", area: "lanes"}` about the missing `## Test lanes` (fast:/coverage:) |
| 2 | doctor.js --json on the octoshell copy | No `warn` lanes finding (exactly one informational `{level: "ok", area: "lanes"}` finding saying the lanes are declared); the section declares fast: `pnpm --filter <pkg> test` and coverage: `pnpm coverage` |
| 3 | Check octoshell CLAUDE.md | Carries the generalised agent-ops rules (no timeout, nohup, qa-env) |

## Expected Final State

Warning only where lanes are undeclared.

## Case text correction (T5.6 QA, 2026-10-06)

Step 2 said "No `lanes` finding" on the octoshell copy. doctor.js emits one `{level: "ok", area: "lanes"}` finding there ("AGENTS.md declares test lanes (fast: pnpm --filter <pkg> test; coverage: pnpm coverage)"), and no warning. The intent (a warning only where lanes are undeclared) holds; the text now says so. The result is unchanged.
