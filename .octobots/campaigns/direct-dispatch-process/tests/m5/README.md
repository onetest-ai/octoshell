# Suite: direct-dispatch-process-m5

Functional cases for **M5 - Plan review before build, and generalised agent-ops guards**, campaign `direct-dispatch-process` (octoshell). 12 cases (9 cli, 1 ui, 2 unit), authored from the mission acceptance criteria (M5-AC1..AC7, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m5`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`: the extension's `--passWithNoTests` exits 0 when nothing matches). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/`; vitests that read real boards take `OCTOBOTS_BOARD_COPIES` (campaign notes § Test conventions).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked|unknown), optional last_run {date, evidence}; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch. `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`.
- `WORK=$(mktemp -d)`; copies of the real boards: `cp -R $SOLO/.octobots $WORK/solo-octobots`, `cp -R $OCTO/.octobots $WORK/octo-octobots`; copies of AGENTS.md of both repos.
- Postgres (for TC-008's probe half): a local server reachable by `psql -d postgres -c 'select 1'`; otherwise that half is UNREACHABLE.
- qa-env.mjs reads `.octobots/qa-env.json` in the current directory (M5-AC4); each qa-env case builds its own `$WORK/qa<N>/.octobots/qa-env.json` with exactly the keys of T5.4's qa-env.example.json: `vars`, `name_pattern`, optional `probe`.
- UI half (TC-004): Extension Development Host (F5) on a copy of solo's board; manual, with screenshots.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M5-AC1 | set-status.js refuses `active` without a plan review; --force overrides and records | TC-001, TC-002, TC-003, TC-005 |
| M5-AC2 | UI status dropdown enforces the same rule with a confirm dialog | TC-004, TC-005 |
| M5-AC3 | Planner § Plan review defines the process | TC-006 |
| M5-AC4 | qa-env.mjs config-driven DB guard (exit 3/4) | TC-007, TC-008, TC-009 |
| M5-AC5 | mission-execution carries server/timeout/background/qa-env rules | TC-006 |
| M5-AC6 | scan-parked.js finds unsigned xfail/skip/todo (git-tracked test files; process.exit( is not a hit) | TC-010, TC-011 |
| M5-AC7 | doctor lanes warning; octoshell declares lanes; gate runs the scan | TC-006, TC-012 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m5` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m5/evidence/`; the run report under `tests/m5/runs/`.

## Pre-existing records

- solo `epic-013-ruleset-and-interval-retention/missions/m10-setup-flow-preset-and-exception-authorization` (draft; neither it nor its campaign has a plan review).
- solo `uwb-ranging-ingest-vendor-v01` campaign notes: '## Plan review (Alex + Rio, 2026-10-02)'.
- solo's real DSN var names `EDGESERVER_POSTGRES_DSN` and `EDGESERVER_POSTGRES_SYNC_DSN` (from `edgeserver/.env` and `.agents/manual-qa/qa-db.sh`).
- octoshell `packages/graph/test/vault-calibration.test.ts:10` (the one real parked test; environmental skipIf).
- solo `edgeserver/tests`: 0 parked markers today. The real parked record is in history: `git -C $SOLO archive f2e7812d^ edgeserver/tests` contains `test_m6_solve_over_the_wire_e2e.py:474 pytest.xfail(` (read-only extraction into $WORK).
- octoshell `packages/graph/bin/octograph.mjs:30` `process.exit(`: the false positive a naive `xit(` pattern would report.
- real AGENTS.md of solo (no `## Test lanes`) and of octoshell after T5.5 (declares lanes).

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: solo's uwb campaign-level plan review (2026-10-02) may name the reviewers as 'Alex + Rio' without a `Reviewers:`/`Verdict:` line: if so the recorded shape would REJECT it, and TC-002 PASSes only when the rule accepts the persona names 'Alex'/'Rio' with an `approved`-class verdict. QA records exactly what the real notes contain; a mismatch is filed as a spec bug, not worked around.
- A2: TC-008 requires a local Postgres; the stub-probe half is covered by the vitest only (that is a synthetic unit check).
- A3: TC-011 scans a read-only `git archive` extraction of solo's history (f2e7812d^) plus today's tree; cross-check with `pytest -rxs` only if the fast lane is cheap; otherwise state not run.
