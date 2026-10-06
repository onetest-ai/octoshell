---
id: TC-013
title: "Solo's legacy uwb heading-only record is accepted with a warning; a one-reviewer heading or a 'Verdict: changes requested' line is refused"
mission: M5
covers: [M5-AC1]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/direct-dispatch-process/tests/m5/runs/RUN-2026-10-06-001.md}
priority: critical
size: S
---

# TC-013: Solo's legacy uwb heading-only record is accepted with a warning; a one-reviewer heading or a 'Verdict: changes requested' line is refused

**Mission:** M5 | **Priority:** critical | **Kind:** cli | **Covers:** M5-AC1

## Objective

Campaign decision 9: a `## Plan review (...)` heading that names both reviewers, with no `Reviewers:`/`Verdict:` lines, counts, and set-status.js warns that the lines are missing. The rule stays narrow: one reviewer is not enough, and an explicit non-approving verdict is never rescued by the heading. Verifies M5-AC1 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on three fresh copies of the uwb campaign.

## Real data (pre-existing record)

solo `uwb-ranging-ingest-vendor-v01` campaign notes: `## Plan review (Alex + Rio, 2026-10-02)` (campaign.yaml line 56, followed by prose, with no Reviewers:/Verdict: line). Mission 'M5 - Emulator v01 gateway and end-to-end ranging match' is cancelled, and cancelled -> executing is a gated move. The two negative copies are derived from that record by a one-line awk edit (stated here, because no real board holds a one-reviewer or changes-requested record).

## Commands

```bash
SS=$PACK/skill/mission-planner/scripts/set-status.js
N="M5 - Emulator v01 gateway and end-to-end ranging match"
H="  ## Plan review (Alex + Rio, 2026-10-02)"
for v in legacy one cr; do cp -R $SOLO/.octobots/campaigns/uwb-ranging-ingest-vendor-v01 $WORK/uwb-$v; done
# derived negatives (portable awk; the YAML block is indented 2 spaces, which is column 0 in the notes)
awk -v h="$H" '$0==h {print "  ## Plan review (Alex, 2026-10-02)"; next} {print}' $SOLO/.octobots/campaigns/uwb-ranging-ingest-vendor-v01/campaign.yaml > $WORK/uwb-one/campaign.yaml
awk -v h="$H" '{print} $0==h {print "  Verdict: changes requested"}' $SOLO/.octobots/campaigns/uwb-ranging-ingest-vendor-v01/campaign.yaml > $WORK/uwb-cr/campaign.yaml
diff $SOLO/.octobots/campaigns/uwb-ranging-ingest-vendor-v01/campaign.yaml $WORK/uwb-one/campaign.yaml
diff $SOLO/.octobots/campaigns/uwb-ranging-ingest-vendor-v01/campaign.yaml $WORK/uwb-cr/campaign.yaml
for v in legacy one cr; do
  M=$WORK/uwb-$v/missions/m5-emulator-v01-gateway-and-end-to-end-ranging-mat
  shasum -a 256 $M/mission.yaml > $WORK/uwb-$v.sha
  node $SS $WORK/uwb-$v "$N" executing 2> $WORK/uwb-$v.err; echo "$v exit=$?"; cat $WORK/uwb-$v.err
  grep -n "^status:" $M/mission.yaml
done
shasum -a 256 -c $WORK/uwb-one.sha $WORK/uwb-cr.sha
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | The two diffs | Each shows exactly one changed or added line at the plan-review heading |
| 2 | legacy copy (the real record) | Exit 0; `status: executing`; stderr holds exactly one line starting `warning: legacy plan review "## Plan review (Alex + Rio, 2026-10-02)" (campaign notes) has no Reviewers:/Verdict: lines; accepted`; no overridden note |
| 3 | one-reviewer copy | Exit 3; stderr names the heading and says it lacks the tech lead (tech-lead or Rio); status still cancelled; shasum OK |
| 4 | changes-requested copy | Exit 3; stderr names the heading, says its Verdict is not approved or approved with nits and that it has no `Reviewers:` line (a section with a Verdict line is judged strictly, never as legacy); status still cancelled; shasum OK |

## Expected Final State

The real legacy record is accepted with a warning, and the narrow legacy rule refuses both derived negatives.
