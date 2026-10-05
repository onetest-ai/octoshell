# Suite: direct-dispatch-process-m3

Functional cases for **M3 - Extension and board library drop Workflow entities**, campaign `direct-dispatch-process` (octoshell). 10 cases (5 unit, 3 cli, 2 ui), authored from the mission acceptance criteria (M3-AC1..AC7, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m3`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter: id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked), optional last_run.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch; a `main` build available for the BEFORE snapshot (TC-003): `git -C $OCTO worktree add $WORK/main-build origin/main && (cd $WORK/main-build && pnpm install && pnpm build)`.
- `WORK=$(mktemp -d)`; copies: `cp -R $SOLO/.octobots $WORK/solo-octobots`, `cp -R $OCTO/.octobots $WORK/octo-octobots`. Never read/write the originals.
- Hash baselines: `find $WORK/solo-octobots $WORK/octo-octobots -path '*/workflows/*' -type f -exec shasum -a 256 {} + | sort > $WORK/wf.before`.
- UI cases (TC-005, TC-009): VS Code Extension Development Host via F5 from $OCTO, with a pre-upgrade VSIX of 0.0.51 available for TC-005 (`code --install-extension`). Not drivable by Playwright MCP.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M3-AC1 | Board library exports no Workflow API; EntityKind 4 kinds; acorn gone | TC-010 |
| M3-AC2 | BoardModel unchanged ids, no workflow entity, no file touched | TC-002, TC-003, TC-004, TC-009 |
| M3-AC3 | validateBoard warns per workflows/ folder, same text as validate.js | TC-006 |
| M3-AC4 | No workflow commands, tree node, RPC method or bind kind | TC-001, TC-002, TC-009 |
| M3-AC5 | Restored octoshell.workflow panel disposed silently | TC-005 |
| M3-AC6 | Graph payload regenerated + verified; octograph map/own run | TC-007, TC-008 |
| M3-AC7 | All gates green; docs workflow-free; command retitled | TC-001, TC-007 |

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
