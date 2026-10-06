---
id: TC-008
title: "Grep the installed copy's skills for Workflow(, workflow.js, add-run, sync-meta, workflow-designer"
mission: M2
covers: [M2-AC1, M2-AC5]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m2/runs/RUN-2026-10-05-001.md}
priority: high
size: S
---

# TC-008: Grep the installed copy's skills for Workflow(, workflow.js, add-run, sync-meta, workflow-designer

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC1, M2-AC5

## Objective

Grep the installed copy's skills for Workflow(, workflow.js, add-run, sync-meta, workflow-designer. Verifies M2-AC1 and M2-AC5 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/solo/.claude/skills and $WORK/octo/.claude/skills after TC-001/TC-002

## Commands

```bash
grep -rnE 'Workflow\(|workflow\.js|add-run|sync-meta|add-workflow|workflow-designer' $WORK/solo/.claude/skills $WORK/octo/.claude/skills --include=*.md --include=*.mjs --include=*.js | grep -v vendor/
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the grep over both installed copies | Only hits: the single 'legacy workflows/ = historical reference only' paragraph in mission-execution and the validate/doctor warning text; no execution instruction |
| 2 | Read the hits in context | None tells an agent to run or author a workflow |

## Expected Final State

No `Workflow(` or workflow.js execution instruction remains.
