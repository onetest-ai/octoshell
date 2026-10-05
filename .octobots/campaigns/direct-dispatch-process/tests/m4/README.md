# Suite: direct-dispatch-process-m4

Functional cases for **M4 - Functional test cases are a gate-run unit of every mission**, campaign `direct-dispatch-process` (octoshell). 11 cases (8 cli, 3 unit), authored from the mission acceptance criteria (M4-AC1..AC6, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m4`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`: the extension's `--passWithNoTests` exits 0 when nothing matches). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/`; vitests that read real boards take `OCTOBOTS_BOARD_COPIES` (campaign notes § Test conventions).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked|unknown), optional last_run {date, evidence}; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch. `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`; run the pack scripts from the pack path, not from an older installed copy.
- `WORK=$(mktemp -d)`; copies: `cp -R $SOLO/.octobots $WORK/solo-octobots`, `cp -R $OCTO/.octobots $WORK/octo-octobots`. Never mutate the originals.
- The uwb copy must contain tests/m1..m6 with their real README/TC files.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M4-AC1 | add-tests.js scaffolds README + links it; idempotent | TC-001, TC-002 |
| M4-AC2 | Pairing gaps (coverage from frontmatter covers; README-map disagreement a separate warning) are WARNINGS only | TC-003, TC-004, TC-005, TC-007, TC-011 |
| M4-AC3 | TC file checks per the TC format contract (warning); validate.js <TC file> exits 0 | TC-006, TC-007 |
| M4-AC4 | Planner documents TC format, modes, record-per-case, authored before build | TC-009 |
| M4-AC5 | Gate QA + last QA task run every TC on real data | TC-010 |
| M4-AC6 | No entity from tests/; watcher skips runs/ and evidence/, still rebuilds once on a TC/README write | TC-008 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m4` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m4/evidence/`; the run report under `tests/m4/runs/`.

## Pre-existing records

- solo `uwb-ranging-ingest-vendor-v01` m1 (11 ACs, README maps M1-AC1..AC10, 22+ TCs) and m2 (10 ACs, maps 9; 32 TCs) with real TC files (legacy `requirements:` frontmatter).
- solo uwb m6 `m6-receiver-port-configuration-file`: status done, no README, no TCs (only runs/ and evidence/).
- octoshell `octograph-code-architecture-graph/missions/m6-extension-bridge`: 5 ACs, no tests folder.
- solo uwb real `TC-003_set-ranging-mode-persists.md` (legacy: `requirements: [M1-AC2, M1-AC5]`, `type: functional`, no status/kind/mission) for the frontmatter checks.
- Coverage agrees with the README maps on uwb today: no TC frontmatter lists M1-AC11 or M2-AC10.

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: octoshell octograph m6's AC count (5) is taken from the board at QA time; the M6-AC1..5 rows in TC-001 follow the real count.
- A2: TC-009 is a behavioural micro-test (5 fresh sub-agents), non-deterministic, costs tokens.
- A3: the TC-006 'passes' expectation relies on the `requirements` alias; if the implementation drops the alias, legacy files warn and TC-006 FAILs the alias decision, which is recorded.
- A4: no real README map row disagrees with its TCs' frontmatter today (uwb m3 names M4-AC6 only in its assumptions prose, not as a map row), so the disagreement half of M4-AC2 is UNREACHABLE on real data; validate-tests-parity.test.ts covers it.
- A5: M4 is verified before M5 lands; if these cases run on a build with M5's plan-review gate, the `active` moves in TC-003/TC-011 need M5's override argument.
