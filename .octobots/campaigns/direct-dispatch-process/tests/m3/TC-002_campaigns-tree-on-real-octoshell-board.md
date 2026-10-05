---
id: TC-002
title: "CampaignsTree on a copy of octoshell's real board shows all missions/tasks/bugs and 0 workflow nodes"
mission: M3
covers: [M3-AC2, M3-AC4]
kind: unit
status: draft
priority: high
size: M
---

# TC-002: CampaignsTree on a copy of octoshell's real board shows all missions/tasks/bugs and 0 workflow nodes

**Mission:** M3 | **Priority:** high | **Kind:** unit | **Covers:** M3-AC2, M3-AC4

## Objective

CampaignsTree on a copy of octoshell's real board shows all missions/tasks/bugs and 0 workflow nodes. Verifies M3-AC2 and M3-AC4 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

$WORK/octo-octobots (copy of octoshell's real octograph campaign: 7 missions, 5 with workflows/)

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPY=$WORK/octo-octobots pnpm --filter @octoshell/vscode-extension test -- campaigns-tree-real-board
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Load the copied board into BoardHost and build the CampaignsTree children for the octograph campaign | 7 mission nodes (m1..m7) with their task and bug children, matching the board-model counts |
| 2 | Walk every node type in the tree | 0 nodes of type `workflow` |

## Expected Final State

Every real entity is shown; no workflow node exists.
