# Suite: direct-dispatch-process-m3

Functional cases for **M3 - Extension and board library drop Workflow entities**, campaign `direct-dispatch-process` (octoshell). 10 cases (5 unit, 3 cli, 2 ui), authored from the mission acceptance criteria (M3-AC1..AC7, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m3`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`: the extension's `--passWithNoTests` exits 0 when nothing matches). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/`; vitests that read real boards take `OCTOBOTS_BOARD_COPIES` (campaign notes § Test conventions).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked|unknown), optional last_run {date, evidence}; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch; a `main` build available for the BEFORE snapshot (TC-003): `git -C $OCTO worktree add $WORK/main-build origin/main && (cd $WORK/main-build && pnpm install && pnpm build)`. Only its built `packages/board/dist/index.js` is used: the committed harness `$OCTO/apps/vscode-extension/scripts/qa/dump-ids.mjs` (T3.3) is run from the mission branch with `--board-dist` pointing at it.
- `WORK=$(mktemp -d)`; copies: `cp -R $SOLO/.octobots $WORK/solo-octobots`, `cp -R $OCTO/.octobots $WORK/octo-octobots`. Never read/write the originals.
- Hash baselines: `find $WORK/solo-octobots $WORK/octo-octobots -path '*/workflows/*' -type f -exec shasum -a 256 {} + | sort > $WORK/wf.before`.
- UI cases (TC-005, TC-009): VS Code Extension Development Host via F5 from $OCTO, with a pre-upgrade VSIX of 0.0.51 available for TC-005 (`code --install-extension`). Not drivable by Playwright MCP.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M3-AC1 | Board library exports no Workflow API; EntityKind 4 kinds; acorn gone (package.json + lockfile) | TC-010 |
| M3-AC2 | BoardModel unchanged ids, no workflow entity, no file touched | TC-002, TC-003, TC-004, TC-009 |
| M3-AC3 | validateBoard warns per workflows/ folder, same text as validate.js | TC-006 |
| M3-AC4 | No workflow commands, tree node, RPC method or bind kind | TC-001, TC-002, TC-009 |
| M3-AC5 | Restored octoshell.workflow panel disposed silently | TC-005 |
| M3-AC6 | Graph payload regenerated + verified; octograph map/own run | TC-007, TC-008 |
| M3-AC7 | All gates green; docs and knowledge notes workflow-free; command retitled; doctor.js and extension.ts quote the new name | TC-001, TC-007 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m3` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m3/evidence/`; the run report under `tests/m3/runs/`.

## Pre-existing records

- octoshell `.octobots/campaigns/octograph-code-architecture-graph` (5 `workflows/build-and-gate/` folders under missions m3..m7; 7 missions, tasks, bugs).
- solo `.octobots` (6 `workflows/` folders: sensor-assignment-uplift m2 with runs.jsonl; five session-replay-track-store-and-read-api missions).
- Total 11 real workflows/ folders across the two boards.
- The octoshell repo itself for `octograph map`/`own`.

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: TC-003's BEFORE snapshot is taken with main's board library (pre-M3) over the same solo copy; the id set is expected to equal 'before' minus workflow ids.
- A2: TC-005 needs a 0.0.51 build that can open a workflow panel; QA records the exact versions used.
- A3: TC-009 and TC-005 are manual (F5, screenshots) and recorded as manual.
- A4: the extension has no production caller of validateBoard, so the M3-AC3 warning is visible only through validate.js/doctor.js; no case expects it in the Problems or Output panel.
