---
id: TC-010
title: "The panel uses theme tokens only, and every status shows a word and a distinct icon"
mission: M1
covers: [M1-AC8, M1-AC9]
kind: unit
status: pass
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: medium
size: S
---

# TC-010: The panel uses theme tokens only, and every status shows a word and a distinct icon

**Mission:** M1 | **Priority:** medium | **Kind:** unit | **Covers:** M1-AC8, M1-AC9

## Objective

No hardcoded colour in the new webview sources, and status stays readable without colour (light, dark and high-contrast themes).

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.

## Real data (pre-existing record)

The shipped sources src/webview/test-case-view.tsx and src/webview/markdown.tsx; this repo's real m6 TCs in all statuses present (pass, blocked) and solo's legacy TC-003 (unknown) in the F5 workspaces.

## Commands

```bash
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/test-case-view-tokens.test.ts test/test-case-view.test.tsx --reporter=verbose
cd $OCTO/apps/vscode-extension && /usr/bin/grep -nE '#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?\b|rgba?\(|hsl\(' src/webview/test-case-view.tsx src/webview/markdown.tsx || echo "no colour literal"
# manual half: F5, Preferences: Color Theme -> Light+, Dark+, High Contrast; screenshot the TC-004 and TC-003 panels in each
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run test-case-view-tokens.test.ts and test-case-view.test.tsx | At least 1 test passed in each, 0 failed |
| 2 | Run the grep | `no colour literal` (any hit is read by hand; a markdown `#` heading is not a colour) |
| 3 | F5: view TC-004 (blocked) and TC-003 (unknown) panels in Light+, Dark+ and High Contrast | Colours follow each theme; the status reads as the word plus its icon (blocked circle-slash, unknown question); the dropdown is labelled Status |

## Expected Final State

Colours come only from theme tokens, and no status depends on colour to be read. Live half recorded as manual.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
