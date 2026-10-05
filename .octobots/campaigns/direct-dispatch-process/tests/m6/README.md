# Suite: direct-dispatch-process-m6

Functional cases for **M6 - Test cases are first-class on the board**, campaign `direct-dispatch-process` (octoshell). 11 cases (2 unit, 5 cli, 4 ui), authored from the mission acceptance criteria (M6-AC1..AC8, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m6`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`: the extension's `--passWithNoTests` exits 0 when nothing matches). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/`; vitests that read real boards take `OCTOBOTS_BOARD_COPIES` (campaign notes § Test conventions).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked|unknown), optional last_run {date, evidence}; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch. `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`.
- `WORK=$(mktemp -d)`; copies: `cp -R $SOLO/.octobots $WORK/solo-octobots`; this campaign's tests are read from $OCTO/.octobots/campaigns/direct-dispatch-process (real, with new frontmatter) and copied to $WORK/octo-octobots for mutation cases.
- UI cases: Extension Development Host (F5) with $OCTO as workspace (this campaign) and a second window on the solo copy; manual, screenshots to tests/m6/evidence/.
- set-test-status.js and validate.js take a TC file only inside a `tests/m<n>/` folder (M4's TC format contract; any other path exits 2), so mutation cases work on the copy `$WORK/octo-octobots/campaigns/direct-dispatch-process/tests/m<n>/` or the solo copy, never on a loose file in $WORK. The dogfood write-back (TC-009) is the one case that writes this mission's own TC files, on the mission branch.
- The board-library harness is the committed `$OCTO/apps/vscode-extension/scripts/qa/dump-tests.mjs <octobots-dir> <campaign-slug>` (T6.1); installPack runs through `$OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs` (T2.3).
- TC-011 (T6.6) runs on the VSIX that `pnpm --filter @octoshell/vscode-extension package` writes to apps/vscode-extension/octobots-0.1.0.vsix after the release commit.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M6-AC1 | Board library parses TC files into a TestCase entity | TC-001, TC-002 |
| M6-AC2 | Malformed/legacy TC: warning + unknown + migrate suggestion | TC-002, TC-003, TC-008 |
| M6-AC3 | Sidebar: Tests node per campaign, grouped by mission, counts, opens file | TC-004, TC-009 |
| M6-AC4 | Mission panel: Tests section + AC coverage view | TC-005, TC-009 |
| M6-AC5 | Campaign panel: test summary | TC-006 |
| M6-AC6 | set-test-status.js writes results back; gate/QA call it | TC-007, TC-008, TC-009 |
| M6-AC7 | Gates green, parity, payload | TC-003, TC-010 |
| M6-AC8 | 0.1.0 VSIX: grep allow-list, new scripts present, 57 markers, solo install up to date, no pairing warnings, 0 unsigned parked | TC-011 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m6` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m6/evidence/`; the run report under `tests/m6/runs/`.

## Pre-existing records

- solo `uwb-ranging-ingest-vendor-v01/tests/m1..m6`: 100+ legacy-frontmatter TCs (`requirements:`, `type:`; no status/kind/mission), m1 with AC11 unmapped, m6 with no README/TCs.
- this campaign's `direct-dispatch-process/tests/m1..m6`: new frontmatter (id, title, mission, covers, kind, status), a mix of ui/cli/unit kinds, M6's own AC coverage.
- real TC `TC-003_set-ranging-mode-persists.md` (uwb m1; `requirements: [M1-AC2, M1-AC5]`, `type: functional`) for the migrate case; octoshell octograph campaign (no tests) for the empty state.
- solo's real `.claude` (two `version: 57-local` forks, workflow-designer, create-team.js) as the install target for the release check.

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: status icons and the count label format `m2 · 32 · 30✓ 1✗ 1 blocked` follow the user's example; omit zero counts; `unknown`/`draft`/`ready` shown as counts without a symbol. QA records the actual label. Counts are read from disk at QA time (this campaign's m2 has 12 TCs on 2026-10-05).
- A4: TC-011 belongs to T6.6 and runs after T6.5, on the VSIX cut from the QA-passed tree.
- A2: this campaign's own TCs are authored with status `draft`; the first QA run flips them (dogfood).
- A3: UI cases (TC-004, TC-005, TC-006) are manual F5 sessions; the data-shape halves are vitest over real copies.
