---
id: TC-009
title: "rollup.ts and rollup.mjs agree on campaign attribution for the same real segments"
mission: M1
covers: [M1-AC5, M1-AC4]
kind: unit
status: draft
priority: high
size: M
---

# TC-009: rollup.ts and rollup.mjs agree on campaign attribution for the same real segments

**Mission:** M1 | **Priority:** high | **Kind:** unit | **Covers:** M1-AC5, M1-AC4

## Objective

rollup.ts and rollup.mjs agree on campaign attribution for the same real segments. Verifies M1-AC5 and M1-AC4 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

a copy of solo's real raw/segments.jsonl (incl. the 7 + 5 campaign-level branches) and solo's real campaign.yaml files, loaded by a vitest as input (no synthetic segments)

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/tokenomics test -- rollup-parity
# the parity test spawns the pack rollup.mjs on the copied board+segments and compares its runs.json to rollup.ts' output (campaign rows, mission rows, unattributed list)
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Copy solo's raw/segments.jsonl and .octobots/campaigns into the test's temp dir | Inputs are the real files |
| 2 | Run rollup.mjs (spawned) and rollup.ts (imported) over them | Both complete |
| 3 | Compare campaign rows, mission rows and the unattributed list | Identical (including campaign-level rows with mission: null) |
| 4 | Also assert the CLI and ClaudeTranscriptSource return the same segment ids for one fixture root | Same ids |

## Expected Final State

No drift between the two implementations on real data.
