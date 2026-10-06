---
id: TC-003
title: "validate.js on solo's sensor-assignment-uplift m2 (has workflows/m2-execution with runs.jsonl): one warning, same exit code"
mission: M2
covers: [M2-AC3]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m2/runs/RUN-2026-10-05-001.md}
priority: critical
size: S
---

# TC-003: validate.js on solo's sensor-assignment-uplift m2 (has workflows/m2-execution with runs.jsonl): one warning, same exit code

**Mission:** M2 | **Priority:** critical | **Kind:** cli | **Covers:** M2-AC3

## Objective

validate.js on solo's sensor-assignment-uplift m2 (has workflows/m2-execution with runs.jsonl): one warning, same exit code. Verifies M2-AC3 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copy of solo `sensor-assignment-uplift/missions/m2-player-role-on-the-edge-match-roster-read-only` (workflows/m2-execution/ with workflow.js and runs.jsonl)

## Commands

```bash
M=$WORK/solo/.octobots/campaigns/sensor-assignment-uplift/missions/m2-player-role-on-the-edge-match-roster-read-only
node $OCTO/.claude/skills/mission-planner/scripts/validate.js $M; echo "v56 exit=$?"      # octoshell's installed v56 copy, read-only, for reference
node $WORK/solo/.claude/skills/mission-planner/scripts/validate.js $M; echo "exit=$?"     # run AFTER TC-001's install (v57 validate)
mv $M/workflows $WORK/wf.aside; node $WORK/solo/.claude/skills/mission-planner/scripts/validate.js $M; echo "entity-only exit=$?"; mv $WORK/wf.aside $M/workflows
find $M/workflows -type f | sort
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Record the exit code of octoshell's installed v56 validate.js on the same dir, for reference | Exit code E0 recorded |
| 2 | Run the v57 validate.js on the mission dir | Exactly one line starting `warning:` that names `workflows/m2-execution` and `no longer read since pack v57` |
| 3 | Compare the exit code with the entity alone (move workflows/ away and rerun) | Same exit code: the warning does not change it |
| 4 | List files under workflows/ | Unchanged (validate never touches them) |

## Expected Final State

One non-fatal warning line; exit code equals the entity-only result; no file touched. The workflow.json half of M2-AC3 has no real record in either board and is recorded UNREACHABLE on real data.
