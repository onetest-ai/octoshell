---
id: TC-005
title: "validate.js given a workflow.js path exits 2 'not an entity file'"
mission: M2
covers: [M2-AC3]
kind: cli
status: draft
priority: medium
size: S
---

# TC-005: validate.js given a workflow.js path exits 2 'not an entity file'

**Mission:** M2 | **Priority:** medium | **Kind:** cli | **Covers:** M2-AC3

## Objective

validate.js given a workflow.js path exits 2 'not an entity file'. Verifies M2-AC3 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copy of octoshell `.../m6-extension-bridge/workflows/build-and-gate/workflow.js`

## Commands

```bash
W=$WORK/octo/.octobots/campaigns/octograph-code-architecture-graph/missions/m6-extension-bridge/workflows/build-and-gate/workflow.js
node $WORK/octo/.claude/skills/mission-planner/scripts/validate.js $W; echo "exit=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate.js with the workflow.js file as argument | Exit code 2 and the message contains `not an entity file` |

## Expected Final State

Exit 2, message names the file as not an entity file.
