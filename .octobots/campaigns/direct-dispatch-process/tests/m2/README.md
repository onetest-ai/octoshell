# Suite: direct-dispatch-process-m2

Functional cases for **M2 - Pack runs missions by direct sub-agent dispatch**, campaign `direct-dispatch-process` (octoshell). 11 cases (9 cli, 2 unit), authored from the mission acceptance criteria (M2-AC1..AC7, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m2`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter: id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked), optional last_run.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch. `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`.
- `WORK=$(mktemp -d)`. Make the copies once: `cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo/` and `cp -R $OCTO/.claude $OCTO/.octobots $WORK/octo/` (so `$WORK/solo/.claude/skills` is solo's real v56/57-local install, `$WORK/octo/.claude/skills` is octoshell's real v56 install). NEVER run a case against the originals.
- installPack is called through the built extension: `node -e 'import("$OCTO/apps/vscode-extension/dist/host/octobots-skill.js").then(m=>m.installPack(...))'` (QA reads the exact export/arguments from octobots-skill.ts; if no node-callable build exists, use the vitest harness in apps/vscode-extension/test).
- Baseline before touching anything: `git -C $SOLO status --short` and `git -C $OCTO status --short` recorded; they must be the same after.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M2-AC1 | Workflow skill + 7 scripts do not exist; 4 skills listed | TC-001, TC-002, TC-008 |
| M2-AC2 | installPack retires them, keeps unknown files | TC-001, TC-002, TC-010 |
| M2-AC3 | validate.js warns per workflows/ folder; not-an-entity exit 2 | TC-003, TC-004, TC-005 |
| M2-AC4 | doctor.js reports one warn with count + fix | TC-006 |
| M2-AC5 | mission-execution = direct dispatch, no workflow, no project literals | TC-008, TC-009, TC-011 |
| M2-AC6 | Gate = 5 dispatched phases + stopping rule | TC-011 |
| M2-AC7 | Gate hook directive says relay, not 'directly' | TC-007 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m2` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m2/evidence/`; the run report under `tests/m2/runs/`.

## Pre-existing records

- Copy of solo `.claude/skills` (mission-execution and mission-completion-gate are `version: 57-local` forks; workflow-designer present; create-team.js present).
- Copy of octoshell `.claude/skills` (v56, all 5 skills; 7 workflow scripts present).
- solo `sensor-assignment-uplift/missions/m2-player-role-on-the-edge-match-roster-read-only/workflows/m2-execution/` (the only folder with runs.jsonl).
- octoshell `octograph-code-architecture-graph/missions/m6-extension-bridge/workflows/build-and-gate/workflow.js`.
- solo uwb mission `m1-venue-ingest-mode-and-vendor-integer-ids` for the gate-hook command JSON.

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: octoshell's m6-extension-bridge folder has a workflows/ subfolder (the plan says 5 octograph missions m3..m7 each hold workflows/build-and-gate); QA confirms the actual folder on the copy and records it.
- A2: TC-009 is non-deterministic and costs tokens: 5 reps, pass requires 5/5 for the prohibition (no Workflow invocation). Documented as a micro-test, not a unit test.
- A3: the installPack harness (see Prerequisites) may need a small vitest wrapper; QA states which was used.
