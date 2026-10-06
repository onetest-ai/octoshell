---
id: TC-005
title: "Legacy, malformed, cancelled-mission, unmatched-folder and oversize TCs render as specified; a legacy pick writes status only; HTML in a body is inert"
mission: M1
covers: [M1-AC2, M1-AC9]
kind: ui
status: blocked
last_run: {date: 2026-10-06, evidence: .octobots/campaigns/octoshell-0-1-1/tests/m1/runs/RUN-2026-10-06-001.md}
priority: high
size: M
---

# TC-005: Legacy, malformed, cancelled-mission, unmatched-folder and oversize TCs render as specified; a legacy pick writes status only; HTML in a body is inert

**Mission:** M1 | **Priority:** high | **Kind:** ui | **Covers:** M1-AC2, M1-AC9

## Objective

The panel copes with solo's legacy test cases and with degenerate records, and renders bodies through the notes panel's sanitizer so agent-written markup cannot inject elements.

## Preconditions

- Suite prerequisites in `README.md` are met (OCTO, SOLO, PACK, SET, WORK, DDP, UWB set; copies made under $WORK; mission branch built).
- Originals under $OCTO/.octobots and $SOLO are untouched; this case works on the copies.
- The manual half runs in an Extension Development Host (F5) and is recorded as manual, with screenshots under `tests/m1/evidence/`.

## Real data (pre-existing record)

$UWB/tests/m1/TC-003_set-ranging-mode-persists.md (legacy: requirements [M1-AC2, M1-AC5], no status/kind/mission/last_run), $UWB/tests/m1/TC-006_mode-change-refused-409-while-live.md (a Steps cell with `<id of first SCHEDULED match from GET {{base_url}}/api/ops/matches>`) and $UWB/tests/m5/TC-001_emulator-v01-5hz-pacing-and-acks.md (uwb M5 is cancelled), in the F5 workspace $WORK/solo-ws. Steps 6-11 edit those COPIES or derive new files from TC-003 (synthetic, and said so: no real TC is malformed, oversize or in an unmatched folder).

## Commands

```bash
# automated half
cd $OCTO && pnpm --filter @octoshell/vscode-extension exec vitest run test/test-case-view.test.tsx --reporter=verbose
# manual half: F5, open folder $WORK/solo-ws
# step 5: a legacy pick, then check the frontmatter
grep -nE '^(status|last_run|kind|mission):' $UWB/tests/m1/TC-003_set-ranging-mode-persists.md
# step 6: unmapped AC on the copy
perl -0pi -e 's/requirements: \[M1-AC2, M1-AC5\]/requirements: [M1-AC2, M1-AC5, M1-AC99]/' $UWB/tests/m1/TC-003_set-ranging-mode-persists.md
# step 7: evidence that does not exist
node $SET $UWB/tests/m1/TC-003_set-ranging-mode-persists.md pass --evidence .octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m1/runs/RUN-1999-01-01-001.md
# step 8: hostile markup appended to the copy of TC-006
printf '\n<script>document.title="pwned"</script>\n<img src=x onerror="document.title=1">\n' >> $UWB/tests/m1/TC-006_mode-change-refused-409-while-live.md
# step 9: malformed (unparseable frontmatter) derived from TC-003
awk 'NR==2{print "id: [unclosed"} {print}' $UWB/tests/m1/TC-003_set-ranging-mode-persists.md > $UWB/tests/m1/TC-901_malformed.md
# step 11: unmatched folder
mkdir -p $UWB/tests/m9 && cp $UWB/tests/m1/TC-006_mode-change-refused-409-while-live.md $UWB/tests/m9/TC-001_unmatched.md
# step 12: oversize (> 4 MiB) derived from TC-003
cp $UWB/tests/m1/TC-003_set-ranging-mode-persists.md $UWB/tests/m1/TC-902_oversize.md && head -c 4300000 /dev/zero | tr '\0' 'x' >> $UWB/tests/m1/TC-902_oversize.md
```

## Steps

| # | Action | Expected Result |
|---|--------|----------------|
| 1 | Run test-case-view.test.tsx | At least 1 test passed, 0 failed (legacy, M1-AC99, not-found evidence, no-frontmatter and sanitizer cases included) |
| 2 | F5 on solo-ws: open uwb > Tests > m1 > TC-003 | Dropdown ENABLED with current value `unknown` shown as a disabled option, options draft, ready, pass, fail, blocked; kind `none`; last run `never run`, no link; inline note `legacy test case: kind and mission not recorded; set-test-status.js <file> --migrate adds them` |
| 3 | Read Covered criteria | M1-AC2 and M1-AC5 with uwb M1's criterion texts, each linking to the uwb M1 mission panel |
| 4 | Open TC-006 and find Steps row 3 | The text `<id of first SCHEDULED match from GET {{base_url}}/api/ops/matches>` is shown literally in the cell |
| 5 | Pick ready in TC-003's dropdown, then run step 5's grep | The panel shows ready and still shows the legacy note; the file has `status: ready` and no `kind:` or `mission:` line (decision 5) |
| 6 | Apply step 6's edit; the panel refreshes | A third row `M1-AC99` reads `not a criterion of M1` with a warning icon and no link |
| 7 | Apply step 7; the panel refreshes | Status pass; last run shows today's UTC date and the RUN-1999 path as plain text marked `not found`, no link |
| 8 | Apply step 8; reopen TC-006; open Developer: Open Webview Developer Tools | The tab title is unchanged (no script ran); the DOM holds no script and no img element from the body; the tags render as nothing or as text |
| 9 | Apply step 9; open TC-901 from the tree | id TC-901 (from the filename), title from the H1, status `unknown`, kind `none`, Covered criteria `none listed`, the body after the frontmatter block rendered, the dropdown disabled with the reason read out by its aria-describedby (inspect in webview DevTools) |
| 10 | Open uwb > Tests > m5 > TC-001 (M5 is cancelled) | Renders normally, dropdown enabled, M5-AC1 with its text; the link opens the cancelled M5 mission panel |
| 11 | Apply step 11; open the m9 group's TC-001 | `mission M9 not found` shown once; no criterion links |
| 12 | Apply step 12; open TC-902 | `too large to show; Open source file`; dropdown disabled with its reason; the button opens the file |

## Expected Final State

Legacy and degenerate records render without errors and say what they are in words; a legacy pick writes status only; HTML in a TC body never becomes live markup. Live half recorded as manual.

## Teardown

Remove $WORK when the run is finished. Nothing outside $WORK was written.
