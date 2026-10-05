---
id: TC-013
title: "Keep my changes on a fresh solo copy: the two 57-local forks stay byte-identical, everything else installs, packStatus lists them"
mission: M2
covers: [M2-AC9, M2-AC10]
kind: cli
status: draft
priority: critical
size: M
---

# TC-013: Keep my changes on a fresh solo copy: the two 57-local forks stay byte-identical, everything else installs, packStatus lists them

**Mission:** M2 | **Priority:** critical | **Kind:** cli | **Covers:** M2-AC9, M2-AC10

## Objective

The decline path of campaign decision 13: Keep my changes skips the changed skills and installs the rest. Verifies M2-AC9 and M2-AC10 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A fresh copy of solo's real `.claude` + `.octobots` (the two `version: 57-local` forks; workflow-designer, mission-planner and knowledge-explorer at v56, byte-identical to the shipped files; create-team.js).

## Commands

```bash
mkdir -p $WORK/solo3 && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo3/
S=$WORK/solo3/.claude/skills
(cd $S && find mission-execution mission-completion-gate -type f | sort | xargs shasum -a 256) > $WORK/forks.sha
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/solo3 --local-changes=keep > $WORK/solo3.json; echo "exit=$?"
(cd $S && shasum -a 256 -c $WORK/forks.sha > /dev/null) && echo "forks byte-identical"
grep -h "^version:" $S/mission-planner/SKILL.md $S/knowledge-explorer/SKILL.md $S/mission-execution/SKILL.md $S/mission-completion-gate/SKILL.md
test ! -e $S/workflow-designer && echo "workflow-designer gone"
for f in add-workflow.js sync-meta.js add-run.js mission-input.js extract-meta.mjs workflow-meta.mjs vendor/acorn.mjs; do test ! -e $S/mission-planner/scripts/$f && echo "$f gone"; done
test -e $S/mission-planner/scripts/create-team.js && echo "create-team KEPT"
jq '{kept: .result.kept, after: .after | {installed, upToDate, upToDateExceptLocal, changes: [.localChanges[] | {skill, version, reason, retired}]}}' $WORK/solo3.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Install with --local-changes=keep | Exit 0; `.result.kept` is [mission-execution, mission-completion-gate] |
| 2 | Check the forks | "forks byte-identical"; both still read `version: 57-local` |
| 3 | Check the rest | mission-planner and knowledge-explorer read `version: 57`; workflow-designer gone (not a local change); the 7 retired files gone (mission-planner was not kept); create-team.js kept |
| 4 | `.after` | installed: true, upToDate: false, upToDateExceptLocal: true, changes = the two forks (version 57-local, reason label, retired false) |

## Expected Final State

The user's forks survive an install untouched, the rest of the pack is current, and packStatus says why it is not up to date.
