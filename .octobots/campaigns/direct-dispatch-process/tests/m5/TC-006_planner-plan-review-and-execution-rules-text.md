---
id: TC-006
title: "Planner § Plan review and mission-execution rules present in the shipped skills"
mission: M5
covers: [M5-AC3, M5-AC5, M5-AC7]
kind: unit
status: draft
priority: high
size: S
---

# TC-006: Planner § Plan review and mission-execution rules present in the shipped skills

**Mission:** M5 | **Priority:** high | **Kind:** unit | **Covers:** M5-AC3, M5-AC5, M5-AC7

## Objective

Planner § Plan review and mission-execution rules present in the shipped skills. Verifies M5-AC3 and M5-AC5 and M5-AC7 of M5 - Plan review before build, and generalised agent-ops guards.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real shipped SKILL.md files

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension test -- skill-conventions
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the conventions vitest | Green: planner has parallel ba+tech-lead read-only dispatch with model:, per-AC real-data evidence, blocking vs nits, the recorded `## Plan review (<roles>, <date>)` shape; execution has nohup+log redirect+curl -m 2, no-timeout/perl alarm, never background test commands (+exceptions), qa-env.mjs for QA servers/migrations/seeds; gate phase 1 calls scan-parked.js |

## Expected Final State

All phrases asserted.
