# Suite: direct-dispatch-process-m2

Functional cases for **M2 - Pack runs missions by direct sub-agent dispatch**, campaign `direct-dispatch-process` (octoshell). 15 cases (12 cli, 1 ui, 2 unit), authored from the mission acceptance criteria (M2-AC1..AC10, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m2`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`: the extension's `--passWithNoTests` exits 0 when nothing matches). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/`; vitests that read real boards take `OCTOBOTS_BOARD_COPIES` (campaign notes § Test conventions).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked|unknown), optional last_run {date, evidence}; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- `pnpm install && pnpm build` in $OCTO on the mission branch.
- Make the copies once: `mkdir -p $WORK/solo $WORK/octo && cp -R $SOLO/.claude $SOLO/.octobots $WORK/solo/ && cp -R $OCTO/.claude $OCTO/.octobots $WORK/octo/` (so `$WORK/solo/.claude/skills` is solo's real v56/57-local install and `$WORK/octo/.claude/skills` is octoshell's real v56 install). NEVER run a case against the originals.
- installPack runs through the committed harness (T2.3): `node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs <workspace> [--pack-root <dir>] [--local-changes=overwrite|keep]`, which prints `{before, localChanges, result, after}` (packStatus before, the locally changed skills it found, installPack's result incl. `kept`, packStatus after). `--local-changes` stands in for the modal's choice (T2.5); the default is keep, so a case that expects the forks replaced passes `--local-changes=overwrite`.
- Hooks resolve the project from CLAUDE_PROJECT_DIR before the cwd, so hook cases set `CLAUDE_PROJECT_DIR=<copy>` explicitly (an agent shell may carry octoshell's).
- Baseline before touching anything: `git -C $SOLO status --short` and `git -C $OCTO status --short` recorded; they must be the same after.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M2-AC1 | Workflow skill + 7 scripts do not exist; 4 skills listed | TC-001, TC-002, TC-008 |
| M2-AC2 | installPack retires them, keeps unknown files | TC-001, TC-002, TC-010, TC-015 |
| M2-AC3 | validate.js warns per workflows/ folder; not-an-entity exit 2 (workflow.json half UNREACHABLE on real data) | TC-003, TC-004, TC-005 |
| M2-AC4 | doctor.js reports one warn with count + fix | TC-006 |
| M2-AC5 | mission-execution = direct dispatch, no workflow, no project-specific commands | TC-008, TC-009, TC-011 |
| M2-AC6 | Gate = 5 dispatched phases + stopping rule | TC-011 |
| M2-AC7 | Gate hook directive says relay, not 'directly' | TC-007 |
| M2-AC8 | Gate and work-log hooks act only on a status change that happened | TC-012 |
| M2-AC9 | installPack asks before overwriting or deleting a locally changed skill (modal; Overwrite / Keep my changes / Cancel), shipped or retired | TC-001, TC-002, TC-013, TC-014, TC-015 |
| M2-AC10 | packStatus reports localChanges; after Keep the activation prompt stays quiet until the pack version or the fork changes | TC-010, TC-013, TC-014 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m2` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m2/evidence/`; the run report under `tests/m2/runs/`.

## Pre-existing records

- Copy of solo `.claude/skills` (mission-execution and mission-completion-gate are `version: 57-local` forks; workflow-designer present; create-team.js present). sha256 on 2026-10-05: solo's mission-planner, knowledge-explorer and workflow-designer (version 56) are byte-identical to the shipped v56 files (`git show 800c62c^:apps/vscode-extension/resources/octobots-pack/skill/<name>/SKILL.md`), so only the two forks are local changes.
- Copy of octoshell `.claude/skills` (v56, all 5 skills, every SKILL.md byte-identical to the shipped v56 file, so no local change; the 6 workflow scripts add-workflow/sync-meta/add-run/mission-input .js and extract-meta/workflow-meta .mjs, plus vendor/acorn.mjs).
- solo `sensor-assignment-uplift/missions/m2-player-role-on-the-edge-match-roster-read-only/workflows/m2-execution/` (the only folder with runs.jsonl).
- octoshell `octograph-code-architecture-graph/missions/m6-extension-bridge/workflows/build-and-gate/workflow.js`.
- solo uwb mission `m1-venue-ingest-mode-and-vendor-integer-ids` (status done) for the gate-hook command JSON.
- Neither board has a workflow.json: M2-AC3's workflow.json half is UNREACHABLE on real data (covered only by scripts-cli-scenarios).

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: octoshell's m6-extension-bridge folder has a workflows/ subfolder (5 octograph missions m3..m7 each hold workflows/build-and-gate); QA confirms the actual folder on the copy and records it.
- A2: TC-009 is non-deterministic and costs tokens: 5 reps, pass requires 5/5 for the prohibition (no Workflow invocation). Documented as a micro-test, not a unit test.
- A3: TC-012's 'refused start' variant needs M5's plan-review gate (a refusal exits 3 once M5 lands); before M5 the no-such-mission call (exit 1, chained with `; echo`) is the real non-write.
- A4: no real workspace holds a locally changed workflow-designer or a numeric-version skill whose content differs; TC-015 derives that variant from solo's real copy by appending one line, and says so. TC-014's modal half is manual (F5).
