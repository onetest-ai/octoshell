---
id: TC-004
title: "Extension tokenomics report includes solo's home-only sessions and reads only octoshell's own slug"
mission: M1
covers: [M1-AC4]
kind: ui
status: pass
last_run: {date: 2026-10-05, evidence: .octobots/campaigns/direct-dispatch-process/tests/m1/runs/RUN-2026-10-05-001.md}
priority: critical
size: L
---

# TC-004: Extension tokenomics report includes solo's home-only sessions and reads only octoshell's own slug

**Mission:** M1 | **Priority:** critical | **Kind:** ui | **Covers:** M1-AC4

## Objective

Extension tokenomics report includes solo's home-only sessions and reads only octoshell's own slug. Verifies M1-AC4 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; mission branch built, so packages/tokenomics/dist is current).
- The qa-m1 worktree from TC-001 exists.

## Real data (pre-existing record)

Solo, whose sessions 011deac1, 138ca3b0 and 39d8025a exist only under ~/.claude/projects/<slug> (its repo-local root holds 6 other sessions that today's extension already reads, so a non-zero report alone proves nothing). Octoshell, whose repo-local `.claude/projects` also holds other projects' slug dirs (-Users-arozumenko-Development-analysta, -private-tmp, ...). tokenomics-report.mjs makes the same ClaudeTranscriptSource + rollup calls the tokenomics:report RPC makes and writes nothing.

## Commands

```bash
# (a) unit half
cd $OCTO && pnpm --filter @octoshell/tokenomics exec vitest run test/claude-source.test.ts test/claude-source-parity.test.ts --reporter=verbose
# (b) the tokenomics:report calls on the real workspaces
node $OCTO/apps/vscode-extension/scripts/qa/tokenomics-report.mjs $SOLO > $WORK/report-solo.json
jq '{slug, roots, segments, slugs, homeOnly: [.sessions[]|select(test("^(011deac1|138ca3b0|39d8025a)"))]}' $WORK/report-solo.json
node $OCTO/apps/vscode-extension/scripts/qa/tokenomics-report.mjs $OCTO | jq '{slug, slugs, segments}'
node $OCTO/apps/vscode-extension/scripts/qa/tokenomics-report.mjs $SOLO/.claude/worktrees/qa-m1 | jq '.slug'
# (c) manual: from $OCTO press F5 (Extension Development Host), open folder $SOLO, open the Tokenomics view, screenshot.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the two claude-source vitest files | At least 1 test passed in each file; none failed |
| 2 | tokenomics-report.mjs on $SOLO | segments > 0 and homeOnly lists all three of 011deac1, 138ca3b0, 39d8025a |
| 3 | tokenomics-report.mjs on $OCTO | slugs is exactly ["-Users-arozumenko-Development-octoshell"]: no analysta, -private-tmp or other slug |
| 4 | tokenomics-report.mjs on the qa-m1 worktree | slug is `-Users-arozumenko-Development-auqanautica` (worktree unwound to the main checkout) |
| 5 | F5, open $SOLO, open the Tokenomics view | Non-zero segments and cost; the session list or totals include the home-only sessions |
| 6 | Open the view on an empty temp folder | Empty state, no error notification |
| 7 | Save screenshots to tests/m1/evidence/ | Screenshots saved |

## Expected Final State

The extension's report reads the home root (the three home-only sessions appear) and only the workspace's own slug. Steps 5-7 are recorded as MANUAL (VS Code/Electron is not Playwright-drivable; there is no @vscode/test-electron harness).
