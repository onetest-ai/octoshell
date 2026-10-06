---
id: TC-009
title: "Crafted paths read, write and open nothing outside the board's tests folders; evidence opens only a workspace file"
mission: M1
covers: [M1-AC7]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: critical
size: S
---

# TC-009: Crafted paths read, write and open nothing outside the board's tests folders; evidence opens only a workspace file

**Mission:** M1 | **Priority:** critical | **Kind:** unit | **Covers:** M1-AC7

## Objective

The existing testFileToOpen guard, moved unchanged into a VS Code-free host module and re-exported from campaigns-tree.ts, is reused by every new entry point (tests:get, tests:setStatus, octoshell.openTestCase from the tree and the mission panel, Open source file), each joining TestCase.path under the board first (testFileArgFromWebview), and the evidence link opens only the path the host reads from the TC itself, inside the workspace.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

The tracked board copy's real TC-004 (m6) and RUN-2026-10-06-001.md as the positive records; crafted negatives (`..` paths, absolute paths, a symlinked TC pointing at a file outside the board, mission.yaml, a tests README.md) built in a scratch copy, which the test names as synthetic.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/tests-detail-rpc.test.ts test/test-case-panel.test.ts test/test-evidence-guard.test.ts test/open-test-file-webview.test.ts --reporter=verbose
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the four test files | At least 1 test passed in each, 0 failed |
| 2 | Read the guard cases of tests-detail-rpc.test.ts | Each crafted path: tests:get null, tests:setStatus refused, every file of the scratch repo byte-identical before and after |
| 3 | Read test-case-panel.test.ts | octoshell.openTestCase with each crafted path opens no panel |
| 4 | Read test-evidence-guard.test.ts | Real RUN file resolves; missing, directory, `..`, absolute and outside-symlink evidence return null; the evidence comes from the file on disk |
| 5 | Read open-test-file-webview.test.ts | Still green (the M6 guard is unchanged) |

## Expected Final State

No new entry point can read, write or open outside campaigns/<c>/tests/ (or, for evidence, outside the workspace).

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
