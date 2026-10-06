# F5 / install checklist: octoshell 0.1.1 M1 (TC-004..TC-008, TC-010 step 3, TC-012 step 8, T1.4 AC4)

Hand this to the person at the keyboard. About 45 minutes. Everything that writes works on COPIES
under `$WORK`; never open the real octoshell or solo (`auqanautica`) folder in a mutating step.
Recorded as `manual` in `tests/m1/runs/RUN-2026-10-06-001.md`; TC-004..TC-008 and TC-012 are
`blocked` until you report back. Screenshots go to
`/Users/arozumenko/Development/octoshell/.octobots/campaigns/octoshell-0-1-1/tests/m1/evidence/` (named below).

The automated half of every case already passed (see the RUN file). What is left is only what VS Code
(Electron) can show: the rendered panel, the click behaviour, the live refresh, the installed VSIX.

## 0. Prep (once)

```bash
export OCTO=/Users/arozumenko/Development/octoshell
export SOLO=/Users/arozumenko/Development/auqanautica          # READ ONLY, only ever copied
export SET=$OCTO/apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/set-test-status.js
export WORK=$(mktemp -d)                                         # keep this shell open; the variables are used below
export DDP=$WORK/octo-ws/.octobots/campaigns/direct-dispatch-process
export UWB=$WORK/solo-ws/.octobots/campaigns/uwb-ranging-ingest-vendor-v01
export EV=$OCTO/.octobots/campaigns/octoshell-0-1-1/tests/m1/evidence
cd $OCTO && git checkout feat/octoshell-0-1-1-m1 && git pull && pnpm install && pnpm build
fresh() { rm -rf $WORK/octo-ws $WORK/solo-ws; mkdir -p $WORK/octo-ws $WORK/solo-ws; \
  cp -R $OCTO/.octobots $WORK/octo-ws/.octobots; cp -R $SOLO/.octobots $WORK/solo-ws/.octobots; }
fresh
echo $WORK
```

**Run `fresh` again before EACH of the parts A to E below** (each mutates the copies; no case may read another's writes).
Close the Extension Development Host window before re-running `fresh`, and reopen the folder after.

Launch: in VS Code with `$OCTO` open, Run and Debug > **Run Octoshell Extension** (F5). In the new
Extension Development Host window: File > Open Folder > `$WORK/octo-ws` (or `$WORK/solo-ws` where stated).
If the "install the pack" prompt shows, click **Not now** (it is not under test).

If an older Octobots is installed in your normal VS Code, uninstall it first, or the two same-id
extensions clash with the dev host.

## A. TC-004: panel contents on a real TC (fresh; open `$WORK/octo-ws`)

1. Sidebar: Direct dispatch process > Tests > m6, **single-click** `TC-004: Sidebar Tests node...`. A panel titled `TC-004: ...` opens. Screenshot `TC-004-01-panel.png`.
2. Header shows: `TC-004`, the title, a **STATUS** label with a select showing `blocked` (word plus a circle-slash icon), kind `ui`, last run `2026-10-06` as a link, and a hint that a pass/fail/blocked pick records today's date and replaces any earlier evidence link.
3. Click the last-run link: `RUN-2026-10-06-001.md` opens in an editor.
4. Covered criteria: one row `M6-AC3` with M6's third criterion text in full. Click it: the M6 mission panel opens.
5. Body: Objective, Preconditions, Real data, Commands (code block), a Steps table with 6 rows and 3 columns, Expected Final State. No `covers:` or `last_run:` frontmatter line visible. Screenshot `TC-004-02-body.png`.
6. Click **Open source file**: TC-004's markdown opens in a text editor.
7. Pick **pass** in the dropdown. While saving the dropdown is disabled; then the panel shows `pass`, last run = today's UTC date with `no evidence` and no link, no notice, no notification; the tree leaf shows pass. Screenshot `TC-004-03-after-pass.png`.

Report: PASS / FAIL per numbered step.

## B. TC-005: legacy, degenerate and sanitized TCs (fresh; open `$WORK/solo-ws`)

Do the edits in a terminal (the panel should refresh after each; wait a few seconds):

1. Sidebar: uwb > Tests > m1 > `TC-003`. Dropdown ENABLED, current value `unknown` shown as a disabled option, options draft/ready/pass/fail/blocked; kind `none`; last run `never run`, no link; inline note `legacy test case: kind and mission not recorded; set-test-status.js <file> --migrate adds them`. Screenshot `TC-005-01-legacy.png`.
2. Covered criteria: `M1-AC2` and `M1-AC5` with uwb M1's texts, each linking to the uwb M1 panel.
3. Open `TC-006`, Steps row 3 shows literally `<id of first SCHEDULED match from GET {{base_url}}/api/ops/matches>`. Screenshot `TC-005-02-sanitizer-literal.png`.
4. In TC-003's panel pick **ready**, then `grep -nE '^(status|last_run|kind|mission):' $UWB/tests/m1/TC-003_set-ranging-mode-persists.md`. Panel shows ready and still shows the legacy note; the file has `status: ready` and no `kind:` or `mission:` line.
5. `perl -0pi -e 's/requirements: \[M1-AC2, M1-AC5\]/requirements: [M1-AC2, M1-AC5, M1-AC99]/' $UWB/tests/m1/TC-003_set-ranging-mode-persists.md`. A third row `M1-AC99` reads `not a criterion of M1` with a warning icon, no link.
6. `node $SET $UWB/tests/m1/TC-003_set-ranging-mode-persists.md pass --evidence .octobots/campaigns/uwb-ranging-ingest-vendor-v01/tests/m1/runs/RUN-1999-01-01-001.md`. Status pass; last run shows today's UTC date and the RUN-1999 path as plain text marked `not found`, no link.
7. `printf '\n<script>document.title="pwned"</script>\n<img src=x onerror="document.title=1">\n' >> $UWB/tests/m1/TC-006_mode-change-refused-409-while-live.md`; reopen TC-006; run **Developer: Open Webview Developer Tools**. Tab title unchanged; DOM holds no `<script>` and no `<img>` from the body. Screenshot `TC-005-03-hostile-markup.png`.
8. `awk 'NR==2{print "id: [unclosed"} {print}' $UWB/tests/m1/TC-003_set-ranging-mode-persists.md > $UWB/tests/m1/TC-901_malformed.md`; open `TC-901`: id `TC-901`, title from the H1, status `unknown`, kind `none`, `none listed`, body rendered, dropdown disabled (in the webview DevTools check its `aria-describedby` text names the reason).
9. uwb > Tests > m5 > `TC-001` (M5 is cancelled): renders normally, dropdown enabled, `M5-AC1` with its text; the link opens the cancelled M5 panel.
10. `mkdir -p $UWB/tests/m9 && cp $UWB/tests/m1/TC-006_mode-change-refused-409-while-live.md $UWB/tests/m9/TC-001_unmatched.md`; open the m9 group's TC-001: `mission M9 not found` shown once, no criterion links.
11. `cp $UWB/tests/m1/TC-003_set-ranging-mode-persists.md $UWB/tests/m1/TC-902_oversize.md && head -c 4300000 /dev/zero | tr '\0' 'x' >> $UWB/tests/m1/TC-902_oversize.md`; open `TC-902`: `too large to show; Open source file`, dropdown disabled with its reason, the button opens the file.

## C. TC-006: an external status change refreshes the panel and the tree (fresh; open `$WORK/octo-ws`)

1. Open TC-004's panel (Direct dispatch process > Tests > m6) and expand the m6 group; note its label and icon. Panel shows `blocked`.
2. In a terminal:
   `node $SET $DDP/tests/m6/TC-004_sidebar-tests-node-counts.md fail --evidence .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-002.md --date 2026-10-07`
   then `shasum $DDP/tests/m6/TC-004_sidebar-tests-node-counts.md`, and again after 10 s (must be equal: the extension wrote nothing).
3. Within a few seconds: the panel shows `fail`, last run `2026-10-07` linking `RUN-2026-10-06-002.md`; the leaf shows the fail icon and word; the m6 group and Tests node gain one fail and lose one blocked, and their icon turns to the failed colour. Screenshot `TC-006-01-after-external-fail.png`.
4. Open TC-003's panel (`TC-003_malformed-tc-warns-not-errors`), then `rm $DDP/tests/m6/TC-003_malformed-tc-warns-not-errors.md`. The panel shows `This test case no longer exists`, no dropdown, no error notification. Screenshot `TC-006-02-deleted.png`.

## D. TC-007: a stale pick never overwrites an agent's status (fresh; open `$WORK/octo-ws`)

```bash
git -C $WORK/octo-ws init -q
F=$DDP/tests/m6/TC-001_parse-own-campaign-tests.md
node $SET $F ready
```
1. Open TC-001's panel (m6); wait until it shows `ready`.
2. `touch $WORK/octo-ws/.git/index.lock` (the watcher now defers its rebuild), then
   `node $SET $F fail --evidence .octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md` and `shasum $F` (call this A).
3. The panel still shows `ready` (rebuild deferred). Pick **pass** in the dropdown. The dropdown is disabled while the call runs; then the panel shows `fail` with the agent's last run (today, RUN-2026-10-06-001.md) and an inline notice (role=status) that the status changed outside the panel and was not saved; no notification. Screenshot `TC-007-01-stale-notice.png`.
4. `shasum $F` (B): A must equal B, and the file holds `status: fail` with the agent's last_run.
5. `rm $WORK/octo-ws/.git/index.lock`. The tree shows fail; the not-saved notice is still shown (it stays until the next pick). Screenshot `TC-007-02-after-lock-removed.png`.
6. Pick **blocked**: the notice disappears; the file holds `status: blocked` and `last_run: {date: <today UTC>}`.

## E. TC-008: single click opens the panel, not the file; restore (fresh; open `$WORK/octo-ws`)

1. Single-click the `TC-004` leaf (m6): the TC-004 panel opens; NO editor tab for `TC-004_sidebar-tests-node-counts.md` appears.
2. Click another tab, then single-click the TC-004 leaf again: the same tab is focused; still exactly one TC-004 panel tab.
3. Click **Open source file**: the raw markdown opens in a text editor.
4. **Developer: Reload Window**. The TC-004 panel is restored with its content; no `no editor registered` or other error. Screenshot `TC-008-01-restored.png`.
5. Open TC-005's panel (`TC-005_mission-panel-tests-and-ac-coverage`), close all other panels, `rm $DDP/tests/m6/TC-005_mission-panel-tests-and-ac-coverage.md`, **Developer: Reload Window**. The restored panel shows `This test case no longer exists`; no error.
6. Open the M6 mission panel (Direct dispatch process > M6), click the TC-004 row in its Tests section: the TC-004 panel is revealed (same tab, no duplicate); no editor tab opens on the raw file. Screenshot `TC-008-02-mission-row-click.png`.

## F. TC-010 step 3: themes (optional, the automated half already passed; open either workspace)

Preferences: Color Theme > **Light+**, then **Dark+**, then **High Contrast**. In each, view the TC-004 (blocked) panel and the uwb TC-003 (unknown) panel (`$WORK/solo-ws`). Colours follow the theme; status reads as the word plus its icon (blocked circle-slash, unknown question); the dropdown is labelled Status. Screenshots `TC-010-<theme>-TC-004.png` and `TC-010-<theme>-TC-003.png`.

## G. The real VSIX: TC-012 step 8 and T1.4 AC4 (needs the 0.1.1 VSIX, built from the branch head)

VSIX: `/Users/arozumenko/Development/octoshell/apps/vscode-extension/octobots-0.1.1.vsix`
(sha256 and size are in the RUN file; rebuild with `pnpm --filter @octoshell/vscode-extension package` if it is missing).

**The 0.0.51 lesson: one window kept running the old code. Fully quit VS Code (Cmd+Q, not just close the window) after every install, and confirm no VS Code process is left (`pgrep -fl "Visual Studio Code"` prints nothing) before reopening.**

**G1. TC-012 step 8, in a separate profile (fresh; uses the copy, not your real board)**
1. Close the Extension Development Host from the parts above and uninstall any older Octobots from your normal profile if it clashes.
2. `code --profile octobots-qa --install-extension $OCTO/apps/vscode-extension/octobots-0.1.1.vsix`
3. **Quit VS Code fully (Cmd+Q)**, check `pgrep -fl "Visual Studio Code"` is empty.
4. `fresh; code --profile octobots-qa $WORK/octo-ws`. In Extensions confirm Octobots **0.1.1**. Click **Not now** on any pack prompt.
5. Single-click a TC leaf (Direct dispatch process > Tests > m6 > TC-004): the TC panel opens (not the raw file). Screenshot `TC-012-01-installed-panel.png`.

**G2. T1.4 AC4: install 0.1.1 into your normal VS Code and check the pack stays up to date (needs your approval, this touches your real install)**
1. `code --install-extension $OCTO/apps/vscode-extension/octobots-0.1.1.vsix --force`
2. **Quit VS Code fully (Cmd+Q)**; confirm no process is left; reopen the octoshell checkout (`code $OCTO`).
3. Expected: NO "install the Octobots pack" prompt (the pack is unchanged at v57). Run **Octobots: Doctor**: no pack-update finding. Extensions list shows Octobots 0.1.1. Screenshot `T1.4-AC4-no-prompt.png`.
4. Tell the agent the result (or paste the Doctor output); T1.4 stays `executing` until you do. A headless proxy already ran on a copy (RUN file: packStatus `upToDate: true` before and after with the 0.1.1 pack), but it is not a substitute for this step.

## Reporting

For each part, send back PASS or FAIL per numbered step and a note for any difference. A failure that is a
product defect is filed as a bug on M1 (nothing is fixed during QA). After your report the agent updates
the RUN file and re-records the TCs with `set-test-status.js` (blocked -> pass/fail).

## Cleanup

`rm -rf $WORK`; if you used the `octobots-qa` profile, remove it from the Profiles menu. Nothing outside `$WORK`
and the evidence folder is written; `$SOLO` is only ever copied.
