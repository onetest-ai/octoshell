---
id: TC-004
title: "Retired workflow-designer: solo's unchanged copy is deleted silently; a changed copy is staged with no upstream.md and is deleted only on overwrite"
mission: M7
covers: [M7-AC1, M7-AC3, M7-AC7]
kind: cli
status: draft
priority: high
size: S
---

# TC-004: Retired workflow-designer: solo's unchanged copy is deleted silently; a changed copy is staged with no upstream.md and is deleted only on overwrite

**Mission:** M7 | **Priority:** high | **Kind:** cli | **Covers:** M7-AC1, M7-AC3, M7-AC7

## Objective

A retired skill gets the same protection as a shipped one, and its brief says the decision is the user's. Verifies M7-AC1, M7-AC3 and M7-AC7 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

solo's real `.claude/skills/workflow-designer` (`version: 56`, byte-identical to the shipped v56 file). No real workspace holds a changed workflow-designer, so the changed variant is derived from this record by appending one line (stated); without it that half is UNREACHABLE on real data.

## Commands

```bash
for v in a b c; do mkdir -p $WORK/wd-$v && cp -R $SOLO/.claude $SOLO/.octobots $WORK/wd-$v/; done
$IP $WORK/wd-a 2>/dev/null | jq -c '[.deviations[].skill]'; test ! -e $WORK/wd-a/.claude/skills/workflow-designer && echo "a: deleted"
for v in b c; do echo "<!-- local note -->" >> $WORK/wd-$v/.claude/skills/workflow-designer/SKILL.md; done
(cd $WORK/wd-b/.claude/skills && find workflow-designer -type f | sort | xargs shasum -a 256) > $WORK/wd-b.sha
$IP $WORK/wd-b 2>/dev/null | jq -c '.deviations[] | select(.skill=="workflow-designer") | {version, reason, retired}'
(cd $WORK/wd-b/.claude/skills && shasum -a 256 -c $WORK/wd-b.sha > /dev/null) && echo "b: kept byte-identical"
ls $WORK/wd-b/.octobots/pack-updates/v57/workflow-designer; grep -i -E "retired|delet|user" $WORK/wd-b/.octobots/pack-updates/v57/workflow-designer/RECONCILE.md
$IP $WORK/wd-c --local-changes=overwrite > /dev/null 2>&1; test ! -e $WORK/wd-c/.claude/skills/workflow-designer && echo "c: deleted"
# (d) the user's answer 'delete' applied by hand (derived, stated), then done
PR=$WORK/wd-b/.claude/skills/octobots-doctor/scripts/pack-reconcile.mjs; (cd $WORK/wd-b && node $PR done workflow-designer); echo "open exit=$?"
rm -rf $WORK/wd-b/.claude/skills/workflow-designer; printf '## Kept local\n\n## Taken from upstream\n\n## Conflicts\n\n- RESOLVED (user, 2026-10-05): workflow-designer: retired upstream; delete it\n' > $WORK/wd-b/.octobots/pack-updates/v57/workflow-designer/DECISIONS.md
(cd $WORK/wd-b && node $PR done workflow-designer); echo "done exit=$?"; jq '.skills | length' $WORK/wd-b/.octobots/pack-updates/pending.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | (a) Default install on the real copy | Deviations are the two forks only; "a: deleted" |
| 2 | (b) Derived changed copy, default | workflow-designer listed with version "56", reason content, retired true; "b: kept byte-identical"; its staging folder has base.md, local.md and RECONCILE.md and no upstream.md; the brief says it was retired and the user decides |
| 3 | (c) Derived changed copy, overwrite | "c: deleted" |
| 4 | (d) done on (b) before and after the user's 'delete' is applied | open exit=3; after removing the folder and writing a closed DECISIONS.md, done exit=0 and 0 entries remain (the retired-skill done condition of M7-AC7) |

## Expected Final State

An unchanged retired skill is cleaned up silently; a changed one is never deleted without Overwrite.
