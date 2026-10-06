# Suite: octoshell-0-1-1-m1

Functional test cases for **M1 - Test-case panel and 0.1.1 release**, campaign `octoshell-0-1-1`. 12 cases (5 unit, 2 cli, 5 ui), authored from the mission acceptance criteria (M1-AC1..AC11, board order) before the mission is built. Every case names a pre-existing record: this repo's real `direct-dispatch-process` test cases and RUN files (on a copy), solo's uwb legacy test cases (on a copy; solo itself is read only), and the 0.1.0 and 0.1.1 VSIXes. A case whose inputs are synthetic says so and names the real file it derives from.

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/octoshell-0-1-1-m1`; TC-012 on the campaign branch at the release commit). Each case holds its exact commands and an Expected Final State. The runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence, writes `runs/RUN-YYYY-MM-DD-NNN.md` (screenshots and command output under `evidence/`), then records each result with `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <RUN file>`. PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.

The campaign's Test conventions apply (campaign notes § Test conventions, which reuse `.octobots/campaigns/direct-dispatch-process/campaign.yaml` notes § Test conventions rules 1, 2, 3, 4, 6 and 8): a case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`); vitests over real boards take `OCTOBOTS_BOARD_COPIES`.

Cases of kind `ui` have an automated half (a vitest over real board copies) and a manual half in an Extension Development Host (F5): VS Code is Electron, not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record the manual half as manual, with screenshots.

## Prerequisites

Shell variables used in the cases:

- `OCTO=/Users/arozumenko/Development/octoshell`
- `SOLO=/Users/arozumenko/Development/auqanautica` (READ ONLY: copy, never write)
- `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`
- `SET=$PACK/skill/mission-planner/scripts/set-test-status.js`
- `WORK=$(mktemp -d)`
- `DDP=$WORK/octo-ws/.octobots/campaigns/direct-dispatch-process` (the copy of this repo's real campaign)
- `UWB=$WORK/solo-ws/.octobots/campaigns/uwb-ranging-ingest-vendor-v01` (the copy of solo's real campaign)

Setup, once per run:

- `pnpm install && pnpm build` in $OCTO on the mission branch (cut from feat/octoshell-0-1-1, which contains M6 B1 at 9c7d17af).
- `mkdir -p $WORK/octo-ws $WORK/solo-ws && cp -R $OCTO/.octobots $WORK/octo-ws/.octobots && cp -R $SOLO/.octobots $WORK/solo-ws/.octobots`. The `octo-ws` and `solo-ws` folders are the F5 workspaces (evidence paths are repo-relative, so they resolve inside the copy).
- **Fresh copies per case (plan re-check, 2026-10-06):** cases TC-004..TC-010 mutate the copies (status picks). Before EACH of them, re-create `$WORK/octo-ws/.octobots` and `$WORK/solo-ws/.octobots` from the originals (`rm -rf` the copy, then the `cp -R` above), so no case reads another case's writes. A case that needs a prior state sets it up in its own steps.
- Before touching solo, record `git -C $SOLO status --short`, `git -C $SOLO rev-parse HEAD` and `find $SOLO/.octobots -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256` into the RUN file; repeat at the end. They must be equal.
- F5: launch *Run Octoshell Extension* from $OCTO, then File > Open Folder `$WORK/octo-ws` (or `$WORK/solo-ws`) in the Extension Development Host. Never open $OCTO or $SOLO themselves for a mutating step.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M1-AC1 | Panel contents on a real TC: header, Status row, covered criteria, rendered body, Open source file; state after the user's own pick | TC-004 |
| M1-AC2 | Legacy TC settable with the --migrate note (decision 5); malformed, cancelled-mission, unmatched-folder and oversize TCs; sanitized body | TC-005 |
| M1-AC3 | Dropdown writes byte-identically to set-test-status.js (s != current; draft/ready without --date; 0 script refusals on real TCs); same-status host no-op; refusals; atomic; symlinks | TC-001, TC-002, TC-003 |
| M1-AC4 | A pick based on a stale view never overwrites an agent's status; notice stays until the next pick; inline non-stale refusals; dropdown disabled in flight | TC-003, TC-007 |
| M1-AC5 | External set-test-status.js write refreshes panel and tree; no extension write; deleted TC | TC-006 |
| M1-AC6 | Single click in the sidebar or a mission-panel row opens the panel, not the file; one panel per TC; restore after reload | TC-008 |
| M1-AC7 | testFileToOpen guard (moved to a VS Code-free module) reused for reads, writes and opens after joining under the board; evidence guard | TC-009 |
| M1-AC8 | Theme tokens only | TC-010 |
| M1-AC9 | Status not conveyed by colour alone | TC-004, TC-005, TC-010 |
| M1-AC10 | 0.1.1 VSIX: version, activation event, CHANGELOG, pack byte-identical to 0.1.0, assets, grep | TC-012 |
| M1-AC11 | Gates green, graph payload unchanged and --verify, tc-io/test-cases/board-model untouched, type-only board imports in protocol/webview, scan-parked, no runtime dependency | TC-001, TC-011 |

## Shared preconditions

- A clean checkout of octoshell on `feat/octoshell-0-1-1-m1` (cut from feat/octoshell-0-1-1, which contains M6 B1 at 9c7d17af), dependencies installed and built.
- Every mutating step works on the copies under `$WORK`; $OCTO's own `.octobots` and $SOLO are never written by a case.
- Evidence under `tests/m1/evidence/`, the run report under `tests/m1/runs/`.

## Pre-existing records

- `direct-dispatch-process/tests/m6/TC-004_sidebar-tests-node-counts.md`: status blocked, kind ui, covers [M6-AC3], last_run {2026-10-06, `.octobots/campaigns/direct-dispatch-process/tests/m6/runs/RUN-2026-10-06-001.md`} (the RUN file exists), a 6-row Steps table. The main panel record.
- `direct-dispatch-process/tests/m{1..7}/TC-*.md`: 80+ new-frontmatter TCs with real last_run lines; one (m7) carries an extra `note:` key inside last_run. The parity corpus.
- solo `uwb-ranging-ingest-vendor-v01/tests/m1/TC-003_set-ranging-mode-persists.md`: legacy frontmatter (`requirements: [M1-AC2, M1-AC5]`, `type: functional`; no status, kind, mission, last_run). The legacy record.
- solo `uwb-ranging-ingest-vendor-v01/tests/m1/TC-006_mode-change-refused-409-while-live.md`: a Steps cell holding `<id of first SCHEDULED match from GET {{base_url}}/api/ops/matches>`. The sanitizer record.
- solo `uwb-ranging-ingest-vendor-v01/tests/m5/TC-001_emulator-v01-5hz-pacing-and-acks.md`: a TC of uwb M5, which is cancelled. The cancelled-mission record.
- solo uwb `tests/m1..m6`: 116 TC files (119 counted at planning; the T1.1 parity run listed 116 TC-*.md under tests/m<n>/), all with frontmatter and all in a folder with a matching mission, none over 4 MiB. The no-frontmatter, unparseable (malformed), unmatched-folder (m9) and oversize cases are therefore derived from TC-003 or TC-006 and say so.
- `packages/board/test/fixtures/tc-status-cases.json` (T1.1): the shared parity case fixture, inputs derived from TC-004 (m6) and uwb TC-003, run over both the shipped script and the TS edit.
- `apps/vscode-extension/octobots-0.1.0.vsix` (built from release commit ea432393) and `apps/vscode-extension/CHANGELOG.md` line 13 (the muddled sentence). The release records.
- octoshell's `octograph-code-architecture-graph` campaign: no tests folder (no Tests node).

## Data policy

A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded with the reason) rather than substituting a fixture. Synthetic inputs (CRLF, BOM, no frontmatter, unparseable YAML, a covers id beyond the mission's count, a hostile body) are derived from the named real files, and the case says so.

## Assumptions to confirm

- A1: the dropdown records no evidence (`last_run: {date: <today UTC>}`), byte-identical to `set-test-status.js <tc> <status> --date <today UTC>` without --evidence; draft and ready are compared with the script run without --date (it refuses --date there). Re-picking the current status is a host no-op, while the script would re-date last_run; parity is asserted only for a status different from the file's (mission notes § Decision).
- A2: the mission panel's TC rows also open the TC panel (user decision 4, 2026-10-06); TC-008 step 7 checks it. The raw file is one click away via Open source file.
- A6: the not-saved notice stays until the user's next pick; an external refresh does not clear it (TC-007 steps 7-8).
- A3: the date is UTC (the script's default), so a pick made after local midnight in UTC+3 records the previous day.
- A4: TC-012 runs on the VSIX T1.4 builds from the release commit; it is executed black-box by T1.5.
- A5: this suite's own TCs are authored `draft`; T1.5's run flips them.
