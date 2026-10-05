---
id: TC-009
title: "Planner micro-test: 5 fresh sub-agents plan a mission on octoshell's board and produce README + a TC with a named record"
mission: M4
covers: [M4-AC4]
kind: cli
status: draft
priority: high
size: L
---

# TC-009: Planner micro-test: 5 fresh sub-agents plan a mission on octoshell's board and produce README + a TC with a named record

**Mission:** M4 | **Priority:** high | **Kind:** cli | **Covers:** M4-AC4

## Objective

Planner micro-test: 5 fresh sub-agents plan a mission on octoshell's board and produce README + a TC with a named record. Verifies M4-AC4 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

octoshell's real board (octograph campaign) as the planning target; v57 mission-planner as the only guidance

## Commands

```bash
# Dispatch 5 fresh sub-agents (model: sonnet, foreground), each in its OWN copy of $WORK/octo-octobots with the v57 mission-planner installed:
#   "Plan a new mission 'M8 - <small feature>' on this board and make it ready to build."
# Check each copy: add-tests.js run; tests/m8/README.md maps every AC; >=1 TC-*.md with frontmatter incl. covers/kind/status and a 'Real data' record that names a pre-existing record (or says UNREACHABLE).
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Dispatch the 5 agents | 5 finished boards |
| 2 | Check README, AC map and document link per copy | 5/5 have tests/m8/README.md mapping every AC and the linked document |
| 3 | Check TC files | 5/5 have >=1 TC with valid frontmatter and a named pre-existing record or an explicit UNREACHABLE |
| 4 | Read flagged cases manually | No fabricated fixtures presented as real data |

## Expected Final State

5/5 conform. Micro-test; costs tokens.
