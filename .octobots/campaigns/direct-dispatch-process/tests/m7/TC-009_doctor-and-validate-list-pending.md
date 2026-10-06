---
id: TC-009
title: "doctor.js and validate.js list pending reconciles on the staged solo copy, and nothing after overwrite"
mission: M7
covers: [M7-AC6]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m7/runs/RUN-2026-10-05-001.md}
priority: high
size: S
---

# TC-009: doctor.js and validate.js list pending reconciles on the staged solo copy, and nothing after overwrite

**Mission:** M7 | **Priority:** high | **Kind:** cli | **Covers:** M7-AC6

## Objective

The health tools report what the primer reports, without changing exit codes. Verifies M7-AC6 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A git copy of solo staged by the real install; its real uwb campaign mission m1 as the validate target.

## Commands

```bash
gitcopy solo9; W=$WORK/solo9; MP=$W/.claude/skills/mission-planner/scripts
M1=$(ls -d $W/.octobots/campaigns/uwb-ranging-ingest-vendor-v01/missions/m1-*)
(cd $W && node $MP/validate.js $M1 > /dev/null; echo "baseline exit=$?")
$IP $W > /dev/null 2>&1
(cd $W && node $MP/doctor.js --json) | jq -c '.findings[] | select(.area=="pack" and (.level=="warn" or .level=="fail"))'
(cd $W && node $MP/validate.js $M1 > $WORK/v9.txt; echo "exit=$?"); grep "pack reconcile pending" $WORK/v9.txt
$IP $W --local-changes=overwrite > /dev/null 2>&1
(cd $W && node $MP/doctor.js --json) | jq -c '[.findings[] | select(.area=="pack" and (.level=="warn" or .level=="fail"))] | length'
(cd $W && node $MP/validate.js $M1 > $WORK/v9b.txt; echo "exit=$?"); grep -c "pack reconcile pending" $WORK/v9b.txt
# a kept content fork at an older integer version (derived: one line appended to the copy's real v56 knowledge-explorer before the install)
mkdir -p $WORK/solo9k && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo9k/ && echo "<!-- local note -->" >> $WORK/solo9k/.claude/skills/knowledge-explorer/SKILL.md
$IP $WORK/solo9k --local-changes=keep > /dev/null 2>&1; (cd $WORK/solo9k && node .claude/skills/mission-planner/scripts/doctor.js --json) | jq -c '[.findings[] | select(.level=="fail")], [.findings[] | select(.msg | test("knowledge-explorer"))]'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Baseline validate.js on uwb m1, then install | Record the baseline exit code |
| 2 | doctor.js --json on the staged copy | Exactly one `warn` finding in area pack (the `ok` and `note` status lines of that area are not findings) `{"level":"warn","area":"pack","msg":"pack reconcile pending: mission-execution (v57), mission-completion-gate (v57)","fix":"run the octobots-doctor skill"}` |
| 3 | validate.js on uwb m1 | `warning: pack reconcile pending: mission-execution (v57)` and `warning: pack reconcile pending: mission-completion-gate (v57)`; exit equals the baseline |
| 4 | Overwrite, then both again | 0 pack warn/fail findings; 0 pending lines; exit equals the baseline |
| 5 | Kept `version: 56` content fork at pack 57 (derived, stated) | No `fail` finding; one line names knowledge-explorer as kept |

## Expected Final State

Pending reconciles are visible in both health tools and gone once resolved.
