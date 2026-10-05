---
id: TC-008
title: "SessionStart primer tells the agent to run octobots-doctor while a finding is actionable, pending reconciles first, and says nothing once none is left"
mission: M7
covers: [M7-AC6]
kind: cli
status: draft
priority: critical
size: S
---

# TC-008: SessionStart primer tells the agent to run octobots-doctor while a finding is actionable, pending reconciles first, and says nothing once none is left

**Mission:** M7 | **Priority:** critical | **Kind:** cli | **Covers:** M7-AC6

## Objective

The trigger of decision 13 (revised, refinement 2): pending reconcile -> named first; leftover workflows/ folders or the legacy config dir -> one line; nothing actionable -> nothing. Verifies M7-AC6 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A git copy of solo staged by the real install (TC-001's state; solo has 6 real workflows/ folders); a copy of octoshell (5 real workflows/ folders, no pending record). The 'nothing actionable' state is derived from the octoshell copy by moving its workflows/ folders out of the copy (stated).

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/octobots-primer.test.ts --reporter=verbose
gitcopy solo8; W=$WORK/solo8; $IP $W > /dev/null 2>&1; unset CLAUDE_CONFIG_DIR
primer() { echo "{\"hook_event_name\":\"$2\"}" | CLAUDE_PROJECT_DIR=$1 node $1/.octobots/hooks/primer.mjs | jq -r '.hookSpecificOutput.additionalContext'; }
NWF=$(cd $W/.octobots/campaigns && ls -d */workflows */missions/*/workflows 2>/dev/null | wc -l | tr -d ' '); echo "workflows=$NWF"
for e in SessionStart PreCompact; do primer $W $e | grep -F 'Octobots health:'; done
$IP $W --local-changes=overwrite > /dev/null 2>&1; primer $W SessionStart | grep -F 'Octobots health:'; primer $W SessionStart | grep -c "pack-updates"
mkdir -p $WORK/octo8 && cp -R $OCTO/.claude $OCTO/.octobots $WORK/octo8/ && $IP $WORK/octo8 > /dev/null 2>&1
primer $WORK/octo8 SessionStart | grep -F 'Octobots health:'
export CLAUDE_CONFIG_DIR=$WORK/octo8/.claude; primer $WORK/octo8 SessionStart | grep -F 'Octobots health:'; unset CLAUDE_CONFIG_DIR
(cd $WORK/octo8/.octobots/campaigns && ls -d */workflows */missions/*/workflows 2>/dev/null) | jq -R '{finding: "workflows", path: ("campaigns/" + .), date: "2026-10-05"}' | jq -s '{acknowledged: .}' > $WORK/octo8/.octobots/doctor-acks.json   # derived: the user declined every folder
primer $WORK/octo8 SessionStart | grep -c 'Octobots health:'; (cd $WORK/octo8 && node .claude/skills/mission-planner/scripts/doctor.js --json) | jq -c '[.findings[] | select(.msg | test("workflows"))] | length'
gitcopy solo8m; $IP $WORK/solo8m > /dev/null 2>&1; echo '{not json' > $WORK/solo8m/.octobots/pack-updates/pending.json
primer $WORK/solo8m SessionStart > $WORK/p8m.txt; echo "exit=$?"; grep -c 'driven by \*\*Octobots\*\*' $WORK/p8m.txt; grep -c 'Pending pack reconciles' $WORK/p8m.txt
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run octobots-primer.test.ts | At least 1 test passed, none failed |
| 2 | Primer on the staged solo copy, SessionStart and PreCompact | Both print exactly `Octobots health: run the octobots-doctor skill before or alongside the user's task. Pending pack reconciles: mission-execution, mission-completion-gate (.octobots/pack-updates/v57/). Leftover workflows/ folders: <workflows>.` (workflows = the count printed, 6 on 2026-10-05) |
| 3 | Overwrite on the solo copy (record cleared), primer again | `Octobots health: run the octobots-doctor skill before or alongside the user's task. Leftover workflows/ folders: <workflows>.`; 0 mentions of pack-updates |
| 4 | Octoshell copy (no record) | The same sentence form naming its 5 workflows/ folders |
| 5 | Same with CLAUDE_CONFIG_DIR=<copy>/.claude | The line ends with `CLAUDE_CONFIG_DIR is set to <copy>/.claude.` |
| 6 | Every octoshell folder acknowledged in doctor-acks.json (derived, stated) | 0 `Octobots health:` lines; doctor.js still reports the workflows finding (count >= 1) |
| 7 | Malformed pending.json on a staged solo copy | exit=0; the primer's routing text is still present (count >= 1, it begins `This repository is driven by **Octobots**`); 0 `Pending pack reconciles` sentences |

## Expected Final State

The next agent session is told about every finding it can act on, reconciles first, in one line, and hears nothing when there is nothing to do.
