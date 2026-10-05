---
id: TC-014
title: "`57+local` counts as current at v57 (no staging, no nag) and as deviated at v58 with its base taken from reconciled-from"
mission: M7
covers: [M7-AC1, M7-AC2, M7-AC3, M7-AC5]
kind: cli
status: draft
priority: high
size: S
---

# TC-014: `57+local` counts as current at v57 (no staging, no nag) and as deviated at v58 with its base taken from reconciled-from

**Mission:** M7 | **Priority:** high | **Kind:** cli | **Covers:** M7-AC1, M7-AC2, M7-AC3, M7-AC5

## Objective

No nag loop after a reconcile, and an exact base for the next update. Verifies M7-AC1, M7-AC2 and M7-AC5 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A git copy of solo whose mission-execution fork is relabelled as a finished reconcile (derived from the real fork, stated): `version: 57+local` and `reconciled-from: <sha256 of the pack's mission-execution SKILL.md>`. mission-completion-gate stays the real `57-local` fork as the contrast. --pack-version 58 is the harness's QA-only override.

## Commands

```bash
gitcopy solo14; W=$WORK/solo14; F=$W/.claude/skills/mission-execution/SKILL.md; UP=$(shasum -a 256 $PACK/skill/mission-execution/SKILL.md | cut -d' ' -f1)
$IP $W > /dev/null 2>&1; printf '## Kept local\n\n## Taken from upstream\n\n## Conflicts\n' > $W/.octobots/pack-updates/v57/mission-execution/DECISIONS.md   # derived: a finished reconcile's log
awk -v up=$UP '!d&&/^version:/{print "version: 57+local"; print "reconciled-from: " up; d=1; next} {print}' $F > $F.new && mv $F.new $F; head -6 $F
shasum -a 256 $F > $WORK/f14.sha
$IP $W 2>/dev/null | jq -c '{dev: [.deviations[] | {skill, reason}], reconciled: .after.reconciled, pending: .result.pending}'; shasum -a 256 -c $WORK/f14.sha; ls $W/.claude/skills/mission-execution/scripts
ls $W/.octobots/pack-updates/v57; jq -c '[.skills[].skill]' $W/.octobots/pack-updates/pending.json
$IP $W --pack-version 58 2>/dev/null | jq -c '[.deviations[] | {skill, version, reason}]'
jq -c '.skills[] | select(.skill=="mission-execution") | .base' $W/.octobots/pack-updates/pending.json
cmp $PACK/skill/mission-execution/SKILL.md $W/.octobots/pack-updates/v58/mission-execution/base.md && echo "base = reconciled-from body"
test -e $W/.octobots/pack-updates/v57/mission-execution/DECISIONS.md && echo "resolved v57 folder kept"
# reconciled against an EARLIER v57 build (derived: reconciled-from = the first v57 build 800c62c)
gitcopy solo14b; W2=$WORK/solo14b; F2=$W2/.claude/skills/mission-execution/SKILL.md; E=$(git -C $OCTO show 800c62c:apps/vscode-extension/resources/octobots-pack/skill/mission-execution/SKILL.md | shasum -a 256 | cut -d' ' -f1)
awk -v up=$E '!d&&/^version:/{print "version: 57+local"; print "reconciled-from: " up; d=1; next} {print}' $F2 > $F2.new && mv $F2.new $F2; shasum -a 256 $F2 > $WORK/f14b.sha
$IP $W2 2>/dev/null | jq -c '[.deviations[] | select(.skill=="mission-execution") | {version, reason}]'; jq -c '.skills[] | select(.skill=="mission-execution") | .base' $W2/.octobots/pack-updates/pending.json; shasum -a 256 -c $WORK/f14b.sha
(cd $W && git check-ignore -q .octobots/pack-updates/v57/mission-execution/DECISIONS.md) || echo "DECISIONS.md not ignored"; (cd $W && git check-ignore -q .octobots/pack-updates/v57/mission-execution/base.md) && echo "base.md ignored"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Install at 57 (after a first install staged both and mission-execution was then marked reconciled) | Deviations: only mission-completion-gate (label); reconciled: [mission-execution]; pending: [mission-completion-gate]; pending.json lists only mission-completion-gate (the installer drops the entry of a skill that is no longer deviated); v57/ still holds both folders; the `57+local` SKILL.md is `OK` (not overwritten) while mission-execution/scripts is installed |
| 2 | Install with --pack-version 58 | mission-execution deviated with version `57+local`, reason reconciled-older; mission-completion-gate still label |
| 3 | Read mission-execution's base | {version 57, source reconciled-from, sha256 = UP}; "base = reconciled-from body" |
| 4 | Check the audit trail | "resolved v57 folder kept"; "DECISIONS.md not ignored" and "base.md ignored" (the logs are committed, the inputs are not) |
| 5 | Reconciled against an earlier v57 build (derived, stated) | mission-execution deviated: version `57+local`, reason reconciled-older; base {version 57, source reconciled-from, sha256 = the 800c62c file's}; the live SKILL.md `OK` (untouched) |

## Expected Final State

A reconciled skill is quiet for its version and comes back, with an exact base, at the next one.
