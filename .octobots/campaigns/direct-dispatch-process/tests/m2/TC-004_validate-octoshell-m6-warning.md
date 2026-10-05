---
id: TC-004
title: "validate.js on octoshell octograph m6-extension-bridge: one warning for build-and-gate"
mission: M2
covers: [M2-AC3]
kind: cli
status: draft
priority: high
size: S
---

# TC-004: validate.js on octoshell octograph m6-extension-bridge: one warning for build-and-gate

**Mission:** M2 | **Priority:** high | **Kind:** cli | **Covers:** M2-AC3

## Objective

validate.js on octoshell octograph m6-extension-bridge: one warning for build-and-gate. Verifies M2-AC3 of M2 - Pack runs missions by direct sub-agent dispatch.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

copy of octoshell `octograph-code-architecture-graph/missions/m6-extension-bridge` (workflows/build-and-gate/workflow.js)

## Commands

```bash
M=$WORK/octo/.octobots/campaigns/octograph-code-architecture-graph/missions/m6-extension-bridge
node $WORK/octo/.claude/skills/mission-planner/scripts/validate.js $M; echo "exit=$?"
C=$WORK/octo/.octobots/campaigns/octograph-code-architecture-graph; node $WORK/octo/.claude/skills/mission-planner/scripts/validate.js $C | grep -c "^warning:"   # campaign-level: one per workflows/ folder under the campaign tree
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run validate.js on the mission | One `warning:` naming workflows/build-and-gate; no error |
| 2 | Run it on the campaign dir | One warning per workflows/ folder reachable from the campaign (5 expected on the real board) |

## Expected Final State

Warnings only; exit 0 for a valid entity.
