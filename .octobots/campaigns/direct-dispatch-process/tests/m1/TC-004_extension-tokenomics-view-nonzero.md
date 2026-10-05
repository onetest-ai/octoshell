---
id: TC-004
title: "Extension Tokenomics view shows non-zero cost for the solo workspace"
mission: M1
covers: [M1-AC4]
kind: ui
status: draft
priority: critical
size: L
---

# TC-004: Extension Tokenomics view shows non-zero cost for the solo workspace

**Mission:** M1 | **Priority:** critical | **Kind:** ui | **Covers:** M1-AC4

## Objective

Extension Tokenomics view shows non-zero cost for the solo workspace. Verifies M1-AC4 of M1 - Tokenomics reads real transcripts and attributes campaign branches.

## Preconditions

- Suite prerequisites in `README.md` are met (variables SOLO, OCTO, PACK, WORK; copies made in $WORK; mission branch built).
- Originals under $SOLO and $OCTO are untouched; this case works on copies.

## Real data (pre-existing record)

the solo workspace (/Users/arozumenko/Development/auqanautica) opened in an Extension Development Host; its real transcripts exist ONLY under ~/.claude/projects/<slug> (solo's <repo>/.claude/projects is a stale snapshot or absent)

## Commands

```bash
# (a) vitest half, from $OCTO:
pnpm --filter @octoshell/tokenomics test -- claude-source
# the suite includes a case that injects the REAL root (~/.claude/projects) and the solo slug and asserts segments.length > 0;
# plus: a path under /.claude/worktrees/ resolves to the main checkout's slug (use $SOLO/.claude/worktrees/qa-m1).
# (b) manual half: from $OCTO run F5 (Extension Development Host), open folder $SOLO, run "Octobots: Open Tokenomics", screenshot.
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run the claude-source vitest suite | Green, including the real-root + worktree-slug cases |
| 2 | F5 the extension, open $SOLO as the workspace | Dev Host opens on solo |
| 3 | Run the command that opens the Tokenomics view | View renders with non-zero segments and a non-zero total cost (not 'no data') |
| 4 | Open the same view on a workspace whose slug has no transcripts (e.g. an empty temp folder) | Empty-state is shown, no error notification |
| 5 | Save screenshots to tests/m1/evidence/ | Screenshots saved |

## Expected Final State

The extension's Tokenomics view reports non-zero segments for solo from the home root. Recorded as MANUAL (VS Code/Electron is not Playwright-drivable; there is no @vscode/test-electron harness).
