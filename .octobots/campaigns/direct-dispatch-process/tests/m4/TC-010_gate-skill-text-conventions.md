---
id: TC-010
title: "Gate/mission-execution skill text carries the record, notes, tick-exactly and BLOCKED rules"
mission: M4
covers: [M4-AC5]
kind: unit
status: draft
priority: high
size: S
---

# TC-010: Gate/mission-execution skill text carries the record, notes, tick-exactly and BLOCKED rules

**Mission:** M4 | **Priority:** high | **Kind:** unit | **Covers:** M4-AC5

## Objective

Gate/mission-execution skill text carries the record, notes, tick-exactly and BLOCKED rules. Verifies M4-AC5 of M4 - Functional test cases are a gate-run unit of every mission.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real shipped SKILL.md files of mission-completion-gate and mission-execution

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/skill-conventions.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the conventions vitest | At least 1 test passed and none failed: each required phrase present in both skills (run every TC, RUN-*.md, PASS/FAIL/BLOCKED/UNREACHABLE with UNREACHABLE written as blocked, record per criterion, QA verification notes via entity-io, tick exactly evidenced criteria, BLOCKED on browser/login failure) |

## Expected Final State

All required phrases asserted.
