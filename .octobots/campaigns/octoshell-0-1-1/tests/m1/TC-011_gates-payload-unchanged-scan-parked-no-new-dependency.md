---
id: TC-011
title: "Gates green, graph payload byte-identical, no parked tests, no new runtime dependency, pack untouched"
mission: M1
covers: [M1-AC11]
kind: cli
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: high
size: S
---

# TC-011: Gates green, graph payload byte-identical, no parked tests, no new runtime dependency, pack untouched

**Mission:** M1 | **Priority:** high | **Kind:** cli | **Covers:** M1-AC11

## Objective

The mission's whole tree passes the repo's gates, and the board change did not move the octograph payload (0.1.0 shipped payload 57) or the pack.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

The mission branch tree; the committed apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs and scripts/graph-payload-versions.json ("57": "12c27149...") as the before-record; main as the dependency baseline.

## Commands

```bash
cd $OCTO && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm coverage   # foreground, Bash timeout
pnpm --filter @octoshell/vscode-extension graph:payload:write
git diff --exit-code -- apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs apps/vscode-extension/scripts/graph-payload-versions.json && echo PAYLOAD-UNCHANGED
node apps/vscode-extension/scripts/graph-payload.mjs --verify; echo "verify exit $?"
git diff --stat 9c7d17af -- packages/board/src/tc-io.ts packages/board/src/test-cases.ts packages/board/src/board-model.ts   # empty
pnpm --filter @octoshell/vscode-extension exec vitest run test/conventions.test.ts --reporter=verbose   # type-only @octoshell/board imports in protocol/webview
git diff --stat main -- apps/vscode-extension/resources/octobots-pack apps/vscode-extension/resources/shipped-skills.json.br   # empty
node apps/vscode-extension/resources/octobots-pack/skill/mission-execution/scripts/scan-parked.js; echo "scan exit $?"
node -e 'const a=JSON.parse(require("child_process").execSync("git show main:apps/vscode-extension/package.json")).dependencies||{}; const b=require("./apps/vscode-extension/package.json").dependencies||{}; console.log(JSON.stringify(Object.keys(b).filter(k=>!(k in a))))'
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run lint, build, typecheck, test, coverage | Every command exits 0; coverage:pack thresholds pass; record per-package test counts |
| 2 | Regenerate the payload and diff; run --verify | `PAYLOAD-UNCHANGED`; verify exit 0 |
| 3 | Diff tc-io.ts, test-cases.ts, board-model.ts against 9c7d17af; run conventions.test.ts | Empty diff; at least 1 test passed, 0 failed |
| 4 | Diff the pack and the shipped-skill store against main | Empty |
| 5 | Run scan-parked.js | Exit 0, 0 unsigned hits |
| 6 | Compare dependencies with main | `[]` |

## Expected Final State

All gates green; the octograph payload, the pack and the runtime dependencies are exactly as in 0.1.0.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
