---
id: TC-007
title: "Extension build (--verify) passes; graph-payload.test.ts green on 57"
mission: M3
covers: [M3-AC6, M3-AC7]
kind: cli
status: draft
priority: high
size: S
---

# TC-007: Extension build (--verify) passes; graph-payload.test.ts green on 57

**Mission:** M3 | **Priority:** high | **Kind:** cli | **Covers:** M3-AC6, M3-AC7

## Objective

Extension build (--verify) passes; graph-payload.test.ts green on 57. Verifies M3-AC6 and M3-AC7 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the real regenerated apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs and scripts/graph-payload-versions.json (diff line for the 57 hash visible in git)

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension build && pnpm --filter @octoshell/vscode-extension test -- graph-payload
git diff origin/main -- apps/vscode-extension/scripts/graph-payload-versions.json | grep '^[+-].*"57"'
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm coverage
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Build the extension (runs graph-payload --verify) | Exit 0 |
| 2 | Run graph-payload.test.ts | Green on version 57 |
| 3 | Diff the versions json against main | Exactly one changed line: the 57 hash (visible) |
| 4 | Run the full gates | lint, typecheck, build, test, coverage all green |

## Expected Final State

Payload regenerated and pinned; repo gates green.
