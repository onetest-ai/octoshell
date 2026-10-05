---
id: TC-008
title: "octograph map and own run on the octoshell repo with the regenerated bundle"
mission: M3
covers: [M3-AC6]
kind: cli
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m3/runs/RUN-2026-10-05-001.md}
priority: high
size: S
---

# TC-008: octograph map and own run on the octoshell repo with the regenerated bundle

**Mission:** M3 | **Priority:** high | **Kind:** cli | **Covers:** M3-AC6

## Objective

octograph map and own run on the octoshell repo with the regenerated bundle. Verifies M3-AC6 of M3 - Extension and board library drop Workflow entities.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the octoshell repo itself (real git history) and its real .octobots board

## Commands

```bash
cd $OCTO && node apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs map; echo "map=$?"
node apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs own; echo "own=$?"
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run `octograph map` with the shipped bundle | Exit 0; prints a module map |
| 2 | Run `octograph own` | Exit 0; board overlay lists entities with no workflow kind |

## Expected Final State

Both exit 0.
