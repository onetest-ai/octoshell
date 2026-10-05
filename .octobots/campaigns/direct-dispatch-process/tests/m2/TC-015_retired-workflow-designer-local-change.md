---
id: TC-015
title: "Retired workflow-designer: solo's unchanged copy is deleted without a question; a locally changed copy is listed, kept on Keep and deleted on Overwrite"
mission: M2
covers: [M2-AC2, M2-AC9]
kind: cli
status: draft
priority: high
size: S
---

# TC-015: Retired workflow-designer: solo's unchanged copy is deleted without a question; a locally changed copy is listed, kept on Keep and deleted on Overwrite

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC2, M2-AC9

## Objective

A retired skill dir gets the same local-change treatment as a shipped one (campaign decision 13). Verifies M2-AC2 and M2-AC9 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo's real `.claude/skills/workflow-designer` (`version: 56`, byte-identical to the shipped v56 file: sha256 c0246fbe5371..., checked 2026-10-05). No real workspace holds a locally changed workflow-designer, so the changed variant is derived from this record by appending one line (stated here); without it that half is UNREACHABLE on real data.

## Commands

```bash
for v in a b c; do mkdir -p $WORK/wd-$v && cp -R $SOLO/.claude $SOLO/.octobots $WORK/wd-$v/; done
shasum -a 256 $WORK/wd-a/.claude/skills/workflow-designer/SKILL.md
# (a) real, unchanged: deleted silently
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/wd-a --local-changes=keep > $WORK/wd-a.json
jq -c '[.localChanges[].skill]' $WORK/wd-a.json; test ! -e $WORK/wd-a/.claude/skills/workflow-designer && echo "a: deleted"
# (b, c) derived: one appended line
for v in b c; do echo "<!-- local note -->" >> $WORK/wd-$v/.claude/skills/workflow-designer/SKILL.md; done
(cd $WORK/wd-b/.claude/skills && find workflow-designer -type f | sort | xargs shasum -a 256) > $WORK/wd-b.sha
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/wd-b --local-changes=keep > $WORK/wd-b.json
jq -c '.localChanges[] | select(.skill=="workflow-designer") | {version, reason, retired}' $WORK/wd-b.json
(cd $WORK/wd-b/.claude/skills && shasum -a 256 -c $WORK/wd-b.sha > /dev/null) && echo "b: kept byte-identical"
node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs $WORK/wd-c --local-changes=overwrite > /dev/null
test ! -e $WORK/wd-c/.claude/skills/workflow-designer && echo "c: deleted"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | (a) Install on the real copy with keep | localChanges lists the two forks only, not workflow-designer; "a: deleted" |
| 2 | (b) Derived changed copy, keep | workflow-designer listed with version "56", reason content, retired true; "b: kept byte-identical" |
| 3 | (c) Derived changed copy, overwrite | "c: deleted" |

## Expected Final State

An unchanged retired skill is cleaned up silently; a changed one is never deleted without Overwrite.
