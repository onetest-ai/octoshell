---
id: TC-003
title: "tests:get returns the panel's data and tests:setStatus writes, or refuses a stale pick without writing"
mission: M1
covers: [M1-AC3, M1-AC4]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: critical
size: S
---

# TC-003: tests:get returns the panel's data and tests:setStatus writes, or refuses a stale pick without writing

**Mission:** M1 | **Priority:** critical | **Kind:** unit | **Covers:** M1-AC3, M1-AC4

## Objective

The host's two new RPCs over a real board copy: the detail the panel renders, a write that equals the script's, and the stale-base refusal that keeps an agent's newer status.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

$DDP/tests/m6/TC-004_sidebar-tests-node-counts.md on the copy (status blocked, covers [M6-AC3], evidence RUN-2026-10-06-001.md, which exists); M6's real third acceptance criterion as the expected criterion text.

## Commands

```bash
cd $OCTO && OCTOBOTS_BOARD_COPIES="$WORK/octo-ws/.octobots" pnpm --filter @octoshell/vscode-extension exec vitest run test/tests-detail-rpc.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run tests-detail-rpc.test.ts | At least 1 test passed, 0 failed |
| 2 | Read the verbose names for the TC-004 detail case | Status, kind and evidence equal the values read from the file's frontmatter (not pinned), criteria M6-AC3 with M6's AC3 text, evidence exists true, a body with no frontmatter line |
| 3 | Read the stale case | base.status ready vs file fail returns reason stale with current.status fail; file bytes unchanged; no entities:changed |
| 4 | Read the write case | pass with a matching base equals set-test-status.js --date <clock day> output on a second copy and emits entities:changed once; ready on a draft file equals set-test-status.js ready (no --date) |
| 5 | Read the no-op case | Re-sending the file's current status (pass on a pass file) returns changed false, bytes and mtime unchanged, no event: the documented host no-op (the script itself would re-date last_run) |
| 6 | Read the legacy case | pass on the TC-003-derived legacy fixture writes status and last_run and leaves kind and mission absent |

## Expected Final State

The RPC layer returns the contract in mission notes § Contracts, writes exactly what the script writes, and never writes when the panel's view is stale.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
