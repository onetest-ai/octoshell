---
id: TC-004
title: "The panel of a real TC shows header, dropdown, kind, last run link, covered criteria, rendered body and Open source file"
mission: M1
covers: [M1-AC1, M1-AC9]
kind: ui
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: critical
size: M
---

# TC-004: The panel of a real TC shows header, dropdown, kind, last run link, covered criteria, rendered body and Open source file

**Mission:** M1 | **Priority:** critical | **Kind:** ui | **Covers:** M1-AC1, M1-AC9

## Objective

Opening the panel of this repo's real TC-004 (M6) shows everything the user asked for, with the status readable as a word and an icon, not by colour alone.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.
- The manual half runs in an Extension Development Host (F5) and is recorded as manual, with screenshots under `tests/m1/evidence/`.

## Real data (pre-existing record)

$DDP/tests/m6/TC-004_sidebar-tests-node-counts.md in the F5 workspace $WORK/octo-ws (expected values read from its frontmatter; at 9c7d17af status blocked, kind ui, covers [M6-AC3], last_run 2026-10-06 -> .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md, a 6-row Steps table).

## Commands

```bash
# automated half
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/test-case-view.test.tsx --reporter=verbose
# manual half: F5, open folder $WORK/octo-ws; screenshots to tests/m1/evidence/TC-004-*.png
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run test-case-view.test.tsx | At least 1 test passed, 0 failed |
| 2 | F5: expand Direct dispatch process > Tests > m6, single-click `TC-004: Sidebar Tests node...` | A panel titled `TC-004: ...` opens |
| 3 | Read the header | `TC-004`, the frontmatter title, a Status row with a visible STATUS label (as on mission/task/bug panels) whose select shows the file's status, the status word next to its icon (blocked: circle-slash), kind `ui`, last run with the file's date as a link, and a hint that a pass/fail/blocked pick records today's date and replaces any earlier evidence link |
| 4 | Click the last run link | RUN-2026-10-06-001.md opens in an editor |
| 5 | Read Covered criteria | One row: `M6-AC3` with M6's third criterion text in full; clicking it opens the M6 mission panel |
| 6 | Read the body | Objective, Preconditions, Real data, Commands (code block), a Steps table with 6 rows and 3 columns, Expected Final State; no frontmatter line (`covers:`, `last_run:`) visible |
| 7 | Click Open source file | TC-004's markdown opens in a text editor |
| 8 | Pick pass in the dropdown (on the copy) | While saving the dropdown is disabled; then the panel shows pass, last run today's UTC date with `no evidence` and no link, no notice, no notification; the tree leaf shows pass |

## Expected Final State

Every element of M1-AC1 is present and correct for TC-004, and its status reads as a word with an icon. Live half recorded as manual.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
