---
id: TC-002
title: "Install into a copy of octoshell .claude: 7 retired scripts gone, js-yaml vendor kept"
mission: M2
covers: [M2-AC1, M2-AC2]
kind: cli
status: draft
priority: high
size: S
---

# TC-002: Install into a copy of octoshell .claude: 7 retired scripts gone, js-yaml vendor kept

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC1, M2-AC2

## Objective

Install into a copy of octoshell .claude: 7 retired scripts gone, js-yaml vendor kept. Verifies M2-AC1 and M2-AC2 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/octo/.claude (copy of octoshell's real v56 install)

## Commands

```bash
ls $WORK/octo/.claude/skills/mission-planner/scripts $WORK/octo/.claude/skills/mission-planner/scripts/vendor
node $OCTO/.qa/install-pack.mjs $WORK/octo
ls $WORK/octo/.claude/skills/mission-planner/scripts $WORK/octo/.claude/skills/mission-planner/scripts/vendor
test -e $WORK/octo/.claude/skills/mission-planner/scripts/vendor/js-yaml.mjs && echo js-yaml KEPT
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | List scripts and vendor before | 7 workflow scripts + vendor/acorn.mjs + vendor/js-yaml.mjs present |
| 2 | Run installPack on the copy | Exit 0 |
| 3 | List again | The 7 scripts and acorn.mjs gone; vendor/js-yaml.mjs and every non-workflow script remain; workflow-designer/ gone |

## Expected Final State

Only the retired files are removed; js-yaml.mjs and the remaining scripts are intact.
