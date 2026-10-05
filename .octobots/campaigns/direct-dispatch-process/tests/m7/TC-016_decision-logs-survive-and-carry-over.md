---
id: TC-016
title: "Decision logs survive every install choice, open questions carry over to the next version, a later build of the same version re-stages, and Overwrite keeps the replaced fork"
mission: M7
covers: [M7-AC3, M7-AC5]
kind: cli
status: draft
priority: critical
size: M
---

# TC-016: Decision logs survive every install choice, open questions carry over to the next version, a later build of the same version re-stages, and Overwrite keeps the replaced fork

**Mission:** M7 | **Priority:** critical | **Kind:** cli | **Covers:** M7-AC3, M7-AC5

## Objective

The installer never deletes a decision log, a superseded escalation is carried into the new brief instead of being lost or asked forever, and a mis-clicked Overwrite is recoverable (decision-13 recheck Q4, provisional). Verifies M7-AC3 and M7-AC5 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Git copies of solo staged by the real install (the two real `57-local` forks). The open escalation is DERIVED (stated): a DECISIONS.md written by hand in the shape of M7-AC7 with one `- ESCALATED:` entry on the xfail rule, standing in for a TC-013 run. The later build of v57 is a copy of the pack with one line appended to mission-completion-gate's SKILL.md (stated).

## Commands

```bash
gitcopy solo16; W=$WORK/solo16; U=$W/.octobots/pack-updates; S=$W/.claude/skills; $IP $W > /dev/null 2>&1
printf '## Kept local\n\n## Taken from upstream\n\n## Conflicts\n\n- ESCALATED: xfail rule: local 0 xfailed blocks; upstream an xfail with a reason is green; question which one?\n' > $U/v57/mission-completion-gate/DECISIONS.md
shasum -a 256 $U/v57/mission-completion-gate/DECISIONS.md > $WORK/d16.sha
# (a) a later build of the same version: one line appended to the pack's gate SKILL.md
mkdir -p $WORK/pack16 && cp -R $PACK/. $WORK/pack16/ && echo "<!-- later v57 build -->" >> $WORK/pack16/skill/mission-completion-gate/SKILL.md
$IP $W --pack-root $WORK/pack16 > /dev/null 2>&1; jq -c '.skills[] | select(.skill=="mission-completion-gate") | {upstreamSha256}' $U/pending.json; shasum -a 256 $WORK/pack16/skill/mission-completion-gate/SKILL.md
grep -A3 "Carried over from v57:" $U/v57/mission-completion-gate/RECONCILE.md; shasum -a 256 -c $WORK/d16.sha
# (b) a newer pack version
$IP $W --pack-version 58 > /dev/null 2>&1; find $U -type f | sort
grep -A3 "Carried over from v57:" $U/v58/mission-completion-gate/RECONCILE.md; shasum -a 256 -c $WORK/d16.sha
# (c) keep at 58, then (d) overwrite at 57
$IP $W --pack-version 58 --local-changes=keep > /dev/null 2>&1; shasum -a 256 -c $WORK/d16.sha
cp $S/mission-completion-gate/SKILL.md $WORK/gate16.local; $IP $W --local-changes=overwrite > /dev/null 2>&1
shasum -a 256 -c $WORK/d16.sha; cmp $U/v57/mission-completion-gate/overwritten-local.md $WORK/gate16.local && echo "fork recoverable"
(cd $W && git check-ignore -q .octobots/pack-updates/v57/mission-completion-gate/overwritten-local.md) && echo "overwritten-local ignored"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Stage, then write the derived open escalation | DECISIONS.md with one `- ESCALATED:` entry |
| 2 | (a) Install from a later v57 build | The gate entry's upstreamSha256 equals the later build's SKILL.md hash (re-staged); RECONCILE.md lists the xfail question under `Carried over from v57:`; DECISIONS.md `OK` |
| 3 | (b) Install with --pack-version 58 | Both entries now under v58/ with fresh inputs; v57/mission-completion-gate/ keeps DECISIONS.md and no input file; v58's RECONCILE.md carries the xfail question; DECISIONS.md `OK` |
| 4 | (c) Keep mine at 58 | DECISIONS.md `OK` |
| 5 | (d) Overwrite at 57 | DECISIONS.md `OK`; "fork recoverable"; "overwritten-local ignored" |

## Expected Final State

No install choice loses a decision log or a fork, and an unanswered question follows the skill to its next version.
