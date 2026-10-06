---
id: TC-003
title: "Re-install is idempotent; an edited fork re-stages its one entry; keep, overwrite and a later pack version update the record"
mission: M7
covers: [M7-AC3, M7-AC5]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m7/runs/RUN-2026-10-05-001.md}
priority: critical
size: M
---

# TC-003: Re-install is idempotent; an edited fork re-stages its one entry; keep, overwrite and a later pack version update the record

**Mission:** M7 | **Priority:** critical | **Kind:** cli | **Covers:** M7-AC3, M7-AC5

## Objective

No duplicate folders or entries, and every choice leaves the record consistent. Verifies M7-AC3 and M7-AC5 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A git copy of solo staged as in TC-001. The edited-fork step appends one line to the copy's real fork (derived, stated). The later version uses the harness's QA-only --pack-version 58.

## Commands

```bash
gitcopy solo3; W=$WORK/solo3; U=$W/.octobots/pack-updates; S=$W/.claude/skills; cp $S/mission-completion-gate/SKILL.md $WORK/solo3-gate.local
$IP $W > /dev/null 2>&1
(cd $U && find . -type f | sort | xargs shasum -a 256; find . -type f | sort | xargs stat -f '%m %N') > $WORK/u1.txt
$IP $W > /dev/null 2>&1
(cd $U && find . -type f | sort | xargs shasum -a 256; find . -type f | sort | xargs stat -f '%m %N') > $WORK/u2.txt
cmp $WORK/u1.txt $WORK/u2.txt && echo "second install: no change"
echo "<!-- local note -->" >> $S/mission-execution/SKILL.md; $IP $W > /dev/null 2>&1
jq -c '[.skills[] | .skill]' $U/pending.json; ls $U/v57; tail -1 $U/v57/mission-execution/local.md
$IP $W --pack-version 58 > /dev/null 2>&1; ls $U; jq -c '{packVersion, skills: [.skills[] | {skill, dir}]}' $U/pending.json
$IP $W --pack-version 58 --local-changes=keep | jq -c '{pending: .result.pending, kept: .result.kept}'; jq -c '{skills: [.skills[].skill], kept}' $U/pending.json; ls $U
$IP $W --local-changes=overwrite | jq -c '{pending: .result.pending, after: .after.upToDate}'; jq -c '.skills' $U/pending.json; find $U -type f | sort; cmp $U/v57/mission-completion-gate/overwritten-local.md $WORK/solo3-gate.local && echo "overwritten-local = fork"
grep -h "^version:" $S/mission-execution/SKILL.md $S/mission-completion-gate/SKILL.md
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Install twice with the default | "second install: no change" (bytes and mtimes under pack-updates identical) |
| 2 | Append a line to the mission-execution fork and install | pending.json still lists each skill once; v57/ holds the same two folders; local.md ends with the appended line |
| 3 | Install with --pack-version 58 | Both entries now carry packVersion 58 with dirs under v58/; the unresolved v57/<skill>/ folders are gone; still one entry per skill |
| 4 | Install with --pack-version 58 and keep | `.result.kept` lists the two forks, pending empty; pending.json has no reconcile entry and records both under kept for 58; v58/<skill>/ folders are gone |
| 5 | Install with overwrite (pack version 57) | pending empty, upToDate true; pending.json has no reconcile entries; no input file (base.md, local.md, upstream.md, RECONCILE.md) left under v57/ or v58/, and each overwritten skill's v57/<skill>/ holds overwritten-local.md equal to the fork; both skills read `version: 57` |

## Expected Final State

Staging and the record are idempotent, one entry per skill, and every choice cleans up after itself.
