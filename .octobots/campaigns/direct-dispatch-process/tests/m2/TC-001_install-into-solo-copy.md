---
id: TC-001
title: "Install into a copy of solo .claude: workflow-designer gone, forks replaced, create-team.js kept"
mission: M2
covers: [M2-AC1, M2-AC2]
kind: cli
status: draft
priority: critical
size: M
---

# TC-001: Install into a copy of solo .claude: workflow-designer gone, forks replaced, create-team.js kept

**Mission:** M2 | **Priority:** critical | **Kind:** cli | **Covers:** M2-AC1, M2-AC2

## Objective

Install into a copy of solo .claude: workflow-designer gone, forks replaced, create-team.js kept. Verifies M2-AC1 and M2-AC2 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo/.claude (copy of solo's real install: workflow-designer, two `57-local` forks, create-team.js)

## Commands

```bash
ls $WORK/solo/.claude/skills; ls $WORK/solo/.claude/skills/mission-planner/scripts
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/solo > $WORK/install-solo.json; echo "exit=$?"
jq '{before: .before.upToDate, after: .after}' $WORK/install-solo.json
ls $WORK/solo/.claude/skills; test ! -e $WORK/solo/.claude/skills/workflow-designer && echo WD_GONE
for f in add-workflow sync-meta add-run mission-input; do test ! -e $WORK/solo/.claude/skills/mission-planner/scripts/$f.js && echo "$f gone"; done
for f in extract-meta workflow-meta; do test ! -e $WORK/solo/.claude/skills/mission-planner/scripts/$f.mjs && echo "$f gone"; done
test ! -e $WORK/solo/.claude/skills/mission-planner/scripts/vendor/acorn.mjs && echo acorn gone
test -e $WORK/solo/.claude/skills/mission-planner/scripts/create-team.js && echo create-team KEPT
grep -h "^version:" $WORK/solo/.claude/skills/*/SKILL.md
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | List skills and scripts before the install | workflow-designer present, 2 forks `57-local`, create-team.js present |
| 2 | Run installPack against the copy through install-pack.mjs | Exit 0; `.before.upToDate` false, `.after.upToDate` true |
| 3 | Check the 8 retired paths | All absent |
| 4 | Check create-team.js | Still present (the installer never deletes unknown files) |
| 5 | Read every remaining SKILL.md version | All `version: 57`; exactly 4 skills installed by the pack (mission-planner, mission-execution, mission-completion-gate, knowledge-explorer) + any non-pack skills solo already had |

## Expected Final State

The solo copy has no workflow-designer or workflow scripts, every pack SKILL.md is v57 (the 57-local forks are overwritten), and create-team.js is kept.
