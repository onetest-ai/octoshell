---
id: TC-011
title: "Gate and mission-execution skill text: 5 dispatched phases, blocking definition, one+one rounds, green definition, numbered rules"
mission: M2
covers: [M2-AC5, M2-AC6]
kind: unit
status: draft
priority: high
size: S
---

# TC-011: Gate and mission-execution skill text: 5 dispatched phases, blocking definition, one+one rounds, green definition, numbered rules

**Mission:** M2 | **Priority:** high | **Kind:** unit | **Covers:** M2-AC5, M2-AC6

## Objective

Gate and mission-execution skill text: 5 dispatched phases, blocking definition, one+one rounds, green definition, numbered rules. Verifies M2-AC5 and M2-AC6 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real shipped mission-completion-gate and mission-execution SKILL.md files

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension test -- skill-conventions
awk '/^[0-9]+\. \*\*/{print $1}' $PACK/skill/mission-execution/SKILL.md | sort | uniq -d   # duplicate rule numbers: must print nothing
grep -nE 'make |edgeserver|uv run|Workflow\(' $PACK/skill/mission-execution/SKILL.md $PACK/skill/mission-completion-gate/SKILL.md
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the conventions vitest | Green: Agent tool, foreground, model:, JSON verdict/BLOCKED, relay questions, resume from board+git, fast/coverage lanes; gate's 5 phases, blocking definition, one review + one fix round, residue as board bugs, green = 0 failed/0 xfailed|todo/no unexplained skip, coverage only on the coverage lane |
| 2 | Check for duplicate rule numbers | None |
| 3 | grep for project literals and Workflow( | No hits |

## Expected Final State

The skills are generic, direct-dispatch, and internally consistent.
