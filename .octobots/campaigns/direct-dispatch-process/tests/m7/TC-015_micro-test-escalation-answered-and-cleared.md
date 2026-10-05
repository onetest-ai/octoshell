---
id: TC-015
title: "Behavioural micro-test: an open escalation is asked again without re-merging, and once the user answers the reconcile finishes, done clears the record and the primer goes quiet about it"
mission: M7
covers: [M7-AC6, M7-AC7, M7-AC8]
kind: cli
status: draft
priority: critical
size: M
---

# TC-015: Behavioural micro-test: an open escalation is asked again without re-merging, and once the user answers the reconcile finishes, done clears the record and the primer goes quiet about it

**Mission:** M7 | **Priority:** critical | **Kind:** cli | **Covers:** M7-AC6, M7-AC7, M7-AC8

## Objective

The escalation round trip: no pending record stays forever, and no nag loop. Verifies M7-AC6, M7-AC7 and M7-AC8 of M7 - Pack updates reconcile locally changed skills with an agent.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK, IP, SCRATCH; the gitcopy helper; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

Three of TC-013's escalated copies (rc-esc-1..3), each a git copy of solo with a real open ESCALATED entry on the xfail rule. The user's answer is given in the follow-up prompt (stated): keep local, 0 xfailed blocks the merge.

## Commands

```bash
# Micro-test convention (M2 TC-009): each rep is a fresh sub-agent (Agent tool, `model: sonnet`, foreground, general-purpose with file tools) on its OWN fresh copy; prompt identical across reps:
#   "Your working directory is <copy>. A SessionStart hook gave you this context: <the primer's additionalContext for <copy>>.
#    Do what it says. The user is not available during this task: where the skill says to ask the user, write what it says to write,
#    stop, and end your reply with your question."
# Score every rep with the checks below, then READ every DECISIONS.md and every flagged output; a template echo is not a pass.
# Re-ask: a fresh agent per copy with the primer's context only (no answer)
for i in 1 2 3; do U=$WORK/rc-esc-$i/.octobots/pack-updates/v57/mission-completion-gate; shasum -a 256 $U/merged.md > $WORK/rc-esc-$i.merged.sha; done
# ... dispatch 3 reps, then per rep:
i=1; W=$WORK/rc-esc-$i; U=$W/.octobots/pack-updates/v57/mission-completion-gate
shasum -a 256 -c $WORK/rc-esc-$i.merged.sha; shasum -a 256 -c $WORK/rc-esc-$i.sha
# Answer: a fresh agent per copy, prompt = the same prompt plus "The user answers the open question on mission-completion-gate: keep local; 0 xfailed blocks the merge."
# ... dispatch 3 reps, then per rep:
grep -n -E '^- RESOLVED \(user, [0-9]{4}-[0-9]{2}-[0-9]{2}\):.*xfail' $U/DECISIONS.md; grep -c '^- ESCALATED:' $U/DECISIONS.md
grep -m1 '^version:' $W/.claude/skills/mission-completion-gate/SKILL.md; grep -c -F '0 xfailed' $W/.claude/skills/mission-completion-gate/SKILL.md; grep -c -F 'Gate timing' $W/.claude/skills/mission-completion-gate/SKILL.md
jq '[.skills[] | select(.action=="reconcile")] | length' $W/.octobots/pack-updates/pending.json
echo '{"hook_event_name":"SessionStart"}' | CLAUDE_PROJECT_DIR=$W node $W/.octobots/hooks/primer.mjs | jq -r '.hookSpecificOutput.additionalContext' | grep -c 'pack-updates'
(cd $W && node .claude/skills/octobots-doctor/scripts/pack-reconcile.mjs done mission-completion-gate); echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Re-ask run on 3 escalated copies | merged.md and the live SKILL.md unchanged (both `OK`); each reply asks the xfail question again |
| 2 | Answer run on the same 3 copies | 3 replies |
| 3 | DECISIONS.md | The entry now reads `- RESOLVED (user, <date>): ...xfail...`; 0 `- ESCALATED:` entries left |
| 4 | Live gate skill | `version: 57+local`; `0 xfailed` present (the user kept local); Gate timing present (taken from upstream) |
| 5 | Record and primer | 0 reconcile entries; the primer mentions pack-updates 0 times |
| 6 | done again | exit 0, prints `no pending reconcile for mission-completion-gate`; pending.json unchanged |
| 7 | Read each answer-run reply | It names the reconciled skill and its DECISIONS.md path |
| 8 | Score | PASS only 3/3 in both runs |

## Expected Final State

An answered escalation finishes the reconcile and clears the record; an unanswered one is asked again, never re-merged.
