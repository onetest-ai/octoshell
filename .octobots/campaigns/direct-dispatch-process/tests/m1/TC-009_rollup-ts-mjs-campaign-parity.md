---
id: TC-009
title: "rollup.ts and rollup.mjs agree on attribution (all 7 precedence steps) for the same real segments"
mission: M1
covers: [M1-AC5, M1-AC4]
kind: unit
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: high
size: M
---

# TC-009: rollup.ts and rollup.mjs agree on attribution (all 7 precedence steps) for the same real segments

**Mission:** M1 | **Priority:** high | **Kind:** unit | **Covers:** M1-AC5, M1-AC4

## Objective

rollup.ts and rollup.mjs agree on attribution (all 7 precedence steps) for the same real segments. Verifies M1-AC5 and M1-AC4 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; the qa-m1 worktree from TC-001 with a fresh collection).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

A `cp -R` copy of the qa-m1 worktree's .octobots (solo's real campaigns, worklog and freshly collected raw/segments.jsonl, incl. the feat/edge-ops-ui, campaign/emulator-arena-loop, chore/uwb-ranging-plan and campaign/sensor-assignment-uplift branches), fed to the parity test via OCTOBOTS_TOKENOMICS_COPY. Without it, the test runs only its table (a synthetic unit check).

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/tokenomics exec vitest run test/rollup-parity.test.ts test/claude-source-parity.test.ts --reporter=verbose
cp -R $SOLO/.claude/worktrees/qa-m1/.octobots $WORK/tk
OCTOBOTS_TOKENOMICS_COPY=$WORK/tk pnpm --filter @octoshell/tokenomics exec vitest run test/rollup-parity.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two parity files | At least 1 test passed in each; the table covers precedence steps 1-7; the sum of runs[] plus unattributed equals the segments' total |
| 2 | Run rollup-parity.test.ts with OCTOBOTS_TOKENOMICS_COPY on the real copy | At least 1 test passed: rollup.mjs (spawned) and rollup.ts produce identical campaign rows, mission rows and unattributed |
| 3 | claude-source-parity: CLI vs ClaudeTranscriptSource on one root set | Same segment ids |

## Expected Final State

No drift between the two implementations on the table or on real data.

## Teardown

- `rm -rf $WORK/tk`
