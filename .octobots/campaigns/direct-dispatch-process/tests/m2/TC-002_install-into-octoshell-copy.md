---
id: TC-002
title: "Install into a copy of octoshell .claude: 7 retired scripts gone, js-yaml vendor kept"
mission: M2
covers: [M2-AC1, M2-AC2, M2-AC9]
kind: cli
status: draft
priority: high
size: S
---

# TC-002: Install into a copy of octoshell .claude: 7 retired scripts gone, js-yaml vendor kept

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC1, M2-AC2, M2-AC9

## Objective

Install into a copy of octoshell .claude: 7 retired scripts gone, js-yaml vendor kept. With no locally changed skill, nothing is kept and no question would be asked. Verifies M2-AC1, M2-AC2 and M2-AC9 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/octo/.claude (copy of octoshell's real v56 install)

## Commands

```bash
ls $WORK/octo/.claude/skills/mission-planner/scripts $WORK/octo/.claude/skills/mission-planner/scripts/vendor
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/octo > $WORK/install-octo.json; echo "exit=$?"
jq '{localChanges: (.localChanges | length), kept: .result.kept, after: .after.upToDate}' $WORK/install-octo.json
ls $WORK/octo/.claude/skills/mission-planner/scripts $WORK/octo/.claude/skills/mission-planner/scripts/vendor
test -e $WORK/octo/.claude/skills/mission-planner/scripts/vendor/js-yaml.mjs && echo js-yaml KEPT
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | List scripts and vendor before | The 6 workflow scripts (add-workflow, sync-meta, add-run, mission-input .js; extract-meta, workflow-meta .mjs) and vendor/acorn.mjs (7 retired files in all) plus vendor/js-yaml.mjs present |
| 2 | Run installPack on the copy through install-pack.mjs (default --local-changes=keep) | Exit 0; `localChanges` 0 (octoshell's v56 skills are byte-identical to the shipped v56 files, so the modal would not show); `kept` empty; `after` true |
| 3 | List again | The 7 retired files gone; vendor/js-yaml.mjs and every non-workflow script remain; workflow-designer/ gone |

## Expected Final State

Only the retired files are removed; js-yaml.mjs and the remaining scripts are intact.
