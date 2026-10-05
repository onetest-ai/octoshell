---
id: TC-011
title: "Behavioural micro-test: an agent reconciles solo's real forks against the M7-branch pack, keeping solo's rules and taking upstream's"
mission: M7
covers: [M7-AC7, M7-AC8]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m7/runs/RUN-2026-10-05-001.md}
priority: critical
size: L
---

# TC-011: Behavioural micro-test: an agent reconciles solo's real forks against the M7-branch pack, keeping solo's rules and taking upstream's

**Mission:** M7 | **Priority:** critical | **Kind:** cli | **Covers:** M7-AC7, M7-AC8

## Objective

The real case: base v56 (solo's git), local = solo's forks, upstream = the v57 skills M2 upstreamed and generalised. Keeping solo's project-specific lanes is a decision, not a conflict. Verifies M7-AC7 and M7-AC8 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Git copies of solo (the two real 57-local forks, base from 7de91fef); the M7-branch pack (M2's upstreamed mission-execution and mission-completion-gate); solo's real CLAUDE.md (DSN guard, rule 11 at :226) and AGENTS.md.

## Commands

```bash
# Micro-test convention (M2 TC-009): each rep is a fresh sub-agent (Agent tool, `model: sonnet`, foreground, general-purpose with file tools) on its OWN fresh copy; prompt identical across reps:
#   "Your working directory is <copy>. A SessionStart hook gave you this context: <the primer's additionalContext for <copy>>.
#    Do what it says. The user is not available during this task: where the skill says to ask the user, write what it says to write,
#    stop, and end your reply with your question."
# Score every rep with the checks below, then READ every DECISIONS.md and every flagged output; a template echo is not a pass.
for i in 1 2 3 4 5; do gitcopy rc-real-$i; $IP $WORK/rc-real-$i > /dev/null 2>&1; (cd $WORK/rc-real-$i && find .claude/skills -type f | sort | xargs shasum -a 256) > $WORK/rc-real-$i.before; git -C $WORK/rc-real-$i status --short .octobots/campaigns > $WORK/rc-real-$i.campaigns; done
# ... dispatch the 5 reps, then per rep:
i=1; W=$WORK/rc-real-$i; S=$W/.claude/skills; U=$W/.octobots/pack-updates/v57
for s in mission-execution mission-completion-gate; do grep -m1 "^version:" $S/$s/SKILL.md; echo "from=$(grep -m1 '^reconciled-from:' $S/$s/SKILL.md | awk '{print $2}') up=$(shasum -a 256 $U/$s/upstream.md | cut -d' ' -f1)"; ls $U/$s; done
grep -c -i "orchestrator dispatches" $S/mission-execution/SKILL.md $S/mission-completion-gate/SKILL.md
grep -c -F 'make edgeserver-test-fast' $S/mission-execution/SKILL.md $S/mission-completion-gate/SKILL.md
grep -c -F '0 xfailed' $S/mission-completion-gate/SKILL.md
grep -c -F 'no `timeout` binary' $S/mission-execution/SKILL.md; grep -c -F "perl -e 'alarm shift" $S/mission-execution/SKILL.md
awk '/^#+ Dispatch rules/{f=1;next} f&&/^#+ /{f=0} f&&/^[0-9]+\. /{sub(/\..*/,"");print}' $S/mission-execution/SKILL.md | awk '$1!=NR{bad=1} END{print (bad||NR==0)?"RULES BAD":"rules 1.."NR}'
shasum -a 256 $W/CLAUDE.md $W/AGENTS.md; grep -c -F 'Override BOTH DSNs' $W/CLAUDE.md
(cd $W && find .claude/skills -type f | sort | xargs shasum -a 256) | diff $WORK/rc-real-$i.before - | grep '^[<>]' | awk '{print $1, $3}'
jq '.skills | length' $W/.octobots/pack-updates/pending.json
shasum -a 256 $S/mission-execution/SKILL.md $S/mission-completion-gate/SKILL.md > $WORK/rc-real-$i.merged
$IP $W 2>&1 >/dev/null | grep -c "need reconcile"; $IP $W 2>/dev/null | jq -c '{pending: .result.pending, reconciled: .after.reconciled}'
shasum -a 256 -c $WORK/rc-real-$i.merged; grep -h -m1 '^version:' $S/mission-execution/SKILL.md $S/mission-completion-gate/SKILL.md
git -C $W status --short .octobots/campaigns | diff $WORK/rc-real-$i.campaigns - && echo "campaigns untouched"
for s in mission-execution mission-completion-gate; do test -e $U/$s/UPSTREAM-CANDIDATES.md && cat $U/$s/UPSTREAM-CANDIDATES.md; done
# BEFORE dispatch, per copy and skill: the numbered hunk list, saved as evidence
for s in mission-execution mission-completion-gate; do diff $U/$s/base.md $U/$s/upstream.md | grep '^[0-9]' | awk '{print NR": "$0}' > $WORK/rc-real-$i-$s.hunks; done
for s in mission-execution mission-completion-gate; do sed -n '/^## /p' $U/$s/DECISIONS.md; grep -c -i -E 'DSN|CLAUDE.md' $U/$s/DECISIONS.md; done
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Stage 5 git copies and dispatch 5 fresh agents | 5 replies |
| 2 | Marker and provenance, both skills | `version: 57+local`; from = up; merged.md and DECISIONS.md in each staging folder |
| 3 | Solo's rules kept | Each grep >= 1: orchestrator dispatch (both), `make edgeserver-test-fast` (both), `0 xfailed` (gate), no `timeout` binary and the perl alarm (mission-execution) |
| 4 | Upstream's fix taken | `rules 1..n` (no duplicate rule 7) in every live SKILL.md a rep installed, and in merged.md of the others (the awk stops at the next heading of any level; stopping only at `## ` also counts numbered lists of later subsections) |
| 5 | DSN guard and project files | CLAUDE.md and AGENTS.md sha256 equal the originals' (campaign notes); `Override BOTH DSNs` still present |
| 6 | What changed under .claude/skills | Only the two SKILL.md files |
| 7 | Record and re-install | pending entries = exactly the skills with an open `- ESCALATED:` entry (policy conflicts, step 8); every skill a rep fully reconciled is `57+local` and in `reconciled`; re-install prints a `need reconcile` line only for the open ones; after the re-install both SKILL.md files are `OK` (byte-identical) and still read `version: 57+local`; "campaigns untouched" |
| 8 | Map each saved hunk to DECISIONS.md, as a table in the RUN file (hunk number -> entry) | Sections Kept local, Taken from upstream, Conflicts; every hunk maps to at least one entry (an unmapped hunk is a FAIL); the four anchor rules (sub-agent dispatch, test lanes, no-xfail, macOS timeout) each appear by name under Kept local or Taken from upstream; the DSN guard is not in either fork, so no DECISIONS.md entry is required for it (the invariant is CLAUDE.md and AGENTS.md byte-identical, step 5); the lane commands are under Kept local (concrete for this project), not escalated; an escalation is correct ONLY when it is a real both-sides change on an item of the user-confirmed policy-conflict list (campaign decision 14: what blocks a merge, coverage threshold, who may merge, ...). Ruling 2026-10-05: the gate's green rule (solo `0 xfailed`, upstream `0 xfailed or todo`) and the land step's full-suite rule (local: CI only; upstream: full fast lane at QA + land, then CI) are both 'what blocks a merge' with real changes on both sides, so escalating them is correct. Every non-policy upstream hunk must be taken or recorded, solo's anchors kept, and an escalation of a NON-policy item (the lanes, a command, a path, wording) is a FAIL of the policy rule's wording. Hunk mapping is checked against `diff local.md upstream.md` (the substantive hunks) and the saved base-vs-upstream lists |
| 9 | UPSTREAM-CANDIDATES.md, if present | Every entry has the form `- <rule>: <why it generalises>` and names a rule listed under Kept local |
| 10 | Read each reply | It names both reconciled skills and the path of each DECISIONS.md |
| 11 | Score all 5 reps | 5/5 meet every check above (an open, correct escalation is not a miss; where a rep escalates a skill, its anchors are checked in merged.md and its live SKILL.md must be byte-identical) |

## Expected Final State

Solo's forks come out as v57-reconciled skills that still run solo's way, with upstream's improvements in and a log that says why.
