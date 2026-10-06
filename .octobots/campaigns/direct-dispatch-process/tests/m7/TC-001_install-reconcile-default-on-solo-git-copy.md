---
id: TC-001
title: "Default install on a git copy of solo stages the two 57-local forks with their exact v56 base and leaves them byte-identical"
mission: M7
covers: [M7-AC1, M7-AC2, M7-AC3, M7-AC5]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m7/runs/RUN-2026-10-05-001.md}
priority: critical
size: M
---

# TC-001: Default install on a git copy of solo stages the two 57-local forks with their exact v56 base and leaves them byte-identical

**Mission:** M7 | **Priority:** critical | **Kind:** cli | **Covers:** M7-AC1, M7-AC2, M7-AC3, M7-AC5

## Objective

The non-interactive default is Reconcile: deviated skills are detected, staged with the right base, and never overwritten; everything else installs. Verifies M7-AC1, M7-AC2, M7-AC3 and M7-AC5 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A git copy of solo (`gitcopy solo1`, see README): the two `version: 57-local` forks, workflow-designer, mission-planner and knowledge-explorer at v56 (byte-identical to the shipped files), create-team.js, and solo's git history, in which commit 7de91fef holds the shipped v56 mission-execution (9af2c928b8310ddd...) and mission-completion-gate (008de10a952f5afe...).

## Commands

```bash
gitcopy solo1; W=$WORK/solo1; S=$W/.claude/skills
(cd $S && shasum -a 256 mission-execution/SKILL.md mission-completion-gate/SKILL.md) > $WORK/solo1-forks.sha
$IP $W > $WORK/solo1.json 2> $WORK/solo1.err; echo "exit=$?"; cat $WORK/solo1.err
jq -c '.deviations[] | {skill, version, reason, retired}' $WORK/solo1.json
jq '{pending: .result.pending, kept: .result.kept, after: .after | {installed, upToDate, upToDateExceptLocal, pendingReconcile}}' $WORK/solo1.json
(cd $S && shasum -a 256 -c $WORK/solo1-forks.sha > /dev/null) && echo "forks byte-identical"
U=$W/.octobots/pack-updates; cat $U/.gitignore; ls $U/v57/*
jq -c '.packVersion, (.skills[] | {skill, action, localVersion, base, retired, dir})' $U/pending.json
for s in mission-execution mission-completion-gate; do git -C $SOLO show 7de91fef:.claude/skills/$s/SKILL.md | cmp - $U/v57/$s/base.md && echo "$s base = 7de91fef"; cmp $S/$s/SKILL.md $U/v57/$s/local.md && echo "$s local ok"; cmp $PACK/skill/$s/SKILL.md $U/v57/$s/upstream.md && echo "$s upstream ok"; grep -c -E "workspace-git|octobots-doctor" $U/v57/$s/RECONCILE.md; done
grep -h "^version:" $S/mission-planner/SKILL.md $S/knowledge-explorer/SKILL.md $S/octobots-doctor/SKILL.md
test ! -e $S/workflow-designer && echo "workflow-designer gone"; test -e $S/mission-planner/scripts/create-team.js && echo "create-team KEPT"
# the M7-branch pack ships only SKILL.md for mission-execution, so the real install has no scripts/ there; derived check: a copy of the pack with placeholder scripts
mkdir -p $WORK/pack-x && cp -R $PACK/. $WORK/pack-x/ && mkdir -p $WORK/pack-x/skill/mission-execution/scripts && echo '// qa env' > $WORK/pack-x/skill/mission-execution/scripts/qa-env.mjs && echo '// scan' > $WORK/pack-x/skill/mission-execution/scripts/scan-parked.js
gitcopy solo1x; $IP $WORK/solo1x --pack-root $WORK/pack-x > /dev/null 2>&1; ls $WORK/solo1x/.claude/skills/mission-execution/scripts; (cd $WORK/solo1x/.claude/skills && shasum -a 256 -c $WORK/solo1-forks.sha)
ls $S/mission-planner/scripts | grep -c -E "^(add-workflow|sync-meta|add-run|mission-input)\.js$"
git -C $W status --short -uall .octobots/pack-updates
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Install with no --local-changes flag | Exit 0; stderr has `2 skill(s) need reconcile` |
| 2 | Read `.deviations` | Exactly mission-execution and mission-completion-gate, version `57-local`, reason label, retired false; workflow-designer is not listed |
| 3 | Read `.result` and `.after` | pending = the two forks, kept empty; installed true, upToDate false, upToDateExceptLocal true, pendingReconcile = the two forks |
| 4 | Check the forks | "forks byte-identical" (the SKILL.md files); the pack's non-SKILL.md files for that skill install beside the untouched fork (verified with a derived pack root holding placeholder scripts; the real qa-env.mjs and scan-parked.js ship with M6 and are verified at release by M6 TC-011); 0 retired scripts left in mission-planner/scripts |
| 5 | Read the staging folder and pending.json | .gitignore is `*`, `!.gitignore`, `!*/`, `!*/*/DECISIONS.md`, `!*/*/UPSTREAM-CANDIDATES.md`; v57/<skill>/ holds base.md, local.md, upstream.md, RECONCILE.md for each; pending.json packVersion 57, two entries with action reconcile, localVersion 57-local, base {version 56, source workspace-git, sha256 9af2c928b831... / 008de10a952f...} |
| 6 | Compare the staged files | base.md equals 7de91fef's file, local.md the fork, upstream.md the pack's file, for both; each RECONCILE.md names workspace-git and octobots-doctor |
| 7 | Check the rest of the install | mission-planner, knowledge-explorer and octobots-doctor read `version: 57`; workflow-designer gone; create-team.js kept; git status under pack-updates lists only `?? .octobots/pack-updates/.gitignore` |

## Expected Final State

Solo's forks are untouched and staged with their true base; the rest of the pack is current; the record says what is pending.
