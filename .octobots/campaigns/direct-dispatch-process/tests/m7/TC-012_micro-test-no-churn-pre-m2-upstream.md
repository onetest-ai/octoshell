---
id: TC-012
title: "Behavioural micro-test: against the pre-M2 v57 file (v56 text plus the marker) a reconcile changes nothing but the marker"
mission: M7
covers: [M7-AC8]
kind: cli
status: draft
priority: high
size: M
---

# TC-012: Behavioural micro-test: against the pre-M2 v57 file (v56 text plus the marker) a reconcile changes nothing but the marker

**Mission:** M7 | **Priority:** high | **Kind:** cli | **Covers:** M7-AC8

## Objective

The trivial real case must not churn: no invented decisions, no rewrites. Verifies M7-AC8 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Git copies of solo (real forks, base v56 from 7de91fef); upstream = the real first v57 build 800c62c of both skills (the v56 text with the version line bumped), placed into a copy of the M7-branch pack.

## Commands

```bash
# Micro-test convention (M2 TC-009): each rep is a fresh sub-agent (Agent tool, `model: sonnet`, foreground, general-purpose with file tools) on its OWN fresh copy; prompt identical across reps:
#   "Your working directory is <copy>. A SessionStart hook gave you this context: <the primer's additionalContext for <copy>>.
#    Do what it says. The user is not available during this task: where the skill says to ask the user, write what it says to write,
#    stop, and end your reply with your question."
# Score every rep with the checks below, then READ every DECISIONS.md and every flagged output; a template echo is not a pass.
mkdir -p $WORK/pack-pre && cp -R $PACK/. $WORK/pack-pre/
for s in mission-execution mission-completion-gate; do git -C $OCTO show 800c62c:apps/vscode-extension/resources/octobots-pack/skill/$s/SKILL.md > $WORK/pack-pre/skill/$s/SKILL.md; done
for i in 1 2 3 4 5; do gitcopy rc-pre-$i; $IP $WORK/rc-pre-$i --pack-root $WORK/pack-pre > /dev/null 2>&1; done
# ... dispatch the 5 reps, then per rep:
i=1; W=$WORK/rc-pre-$i; S=$W/.claude/skills; U=$W/.octobots/pack-updates/v57
for s in mission-execution mission-completion-gate; do diff $U/$s/base.md $U/$s/upstream.md | grep -c '^[0-9]'
  diff <(grep -v -E '^(version|reconciled-from):' $U/$s/local.md) <(grep -v -E '^(version|reconciled-from):' $S/$s/SKILL.md) > /dev/null && echo "$s: only marker lines differ"
  grep -m1 "^version:" $S/$s/SKILL.md; grep -c '^- ' $U/$s/DECISIONS.md; grep -c -F 'No upstream change since the base apart from the version marker; local kept as is.' $U/$s/DECISIONS.md; done
jq '.skills | length' $W/.octobots/pack-updates/pending.json
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Build the pre-M2 pack root and stage 5 git copies | base.md vs upstream.md differ in 1 hunk (the version line) for both skills |
| 2 | Dispatch 5 fresh agents | 5 replies |
| 3 | Per skill | "only marker lines differ"; `version: 57+local`; 0 `- ` entries in DECISIONS.md; the no-upstream-change line present once |
| 4 | Record | 0 pending entries |
| 5 | Score all 5 reps | 5/5 |

## Expected Final State

When upstream brought nothing, the reconcile records that in one line and leaves the fork as it was.
