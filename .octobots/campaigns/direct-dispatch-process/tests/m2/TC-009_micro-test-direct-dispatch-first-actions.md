---
id: TC-009
title: "Behavioural micro-test: 5 fresh sub-agents plan Agent dispatches, none invokes Workflow"
mission: M2
covers: [M2-AC5]
kind: cli
status: draft
priority: high
size: L
---

# TC-009: Behavioural micro-test: 5 fresh sub-agents plan Agent dispatches, none invokes Workflow

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC5

## Objective

Behavioural micro-test: 5 fresh sub-agents plan Agent dispatches, none invokes Workflow. Verifies M2-AC5 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

octoshell's real `octograph-code-architecture-graph/missions/m6-extension-bridge` (HAS a workflows/build-and-gate/workflow.js) as the board the agents are shown, with the v57 mission-execution SKILL.md as their only guidance

## Commands

```bash
# Dispatch 5 independent fresh sub-agents (Agent tool, model: sonnet, foreground). Prompt (identical for all 5):
#   "Given ONLY this skill (<v57 mission-execution/SKILL.md>) and this mission board (<copy of m6 incl. its workflows/ folder>),
#    list the first three actions you take to start executing task T6.1. Do not run anything."
# Score each reply programmatically then READ every flagged one.
# PASS iff all 5 plan an Agent dispatch with an explicit model: for the first phase, and 0 of 5 mention invoking Workflow or running workflow.js.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Prepare the prompt with the v57 skill text and a copy of the real m6 mission (workflows/ folder included) | Prompt ready |
| 2 | Dispatch 5 fresh sub-agents with an identical prompt | 5 replies |
| 3 | Score each: plans Agent dispatch with model:?  mentions Workflow/workflow.js as a way to run? | 5/5 plan an Agent dispatch with model:; 0/5 invoke Workflow |
| 4 | Read every flagged match manually | No false positives hiding a violation |

## Expected Final State

5/5 conform. Recorded as a micro-test (costs tokens; non-deterministic). Fewer than 5/5 is a FAIL and files a bug against the skill wording.
