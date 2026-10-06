# Suite: direct-dispatch-process-m1

Functional cases for **M1 - Tokenomics reads real transcripts and attributes campaign branches**, campaign `direct-dispatch-process` (octoshell). 11 cases (9 cli, 1 ui, 1 unit), authored from the mission acceptance criteria (M1-AC1..AC8, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m1`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`: the extension's `--passWithNoTests` exits 0 when nothing matches). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/`; vitests that read real boards take `OCTOBOTS_BOARD_COPIES` (campaign notes § Test conventions).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked|unknown), optional last_run {date, evidence}; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`, `SLUG=-Users-arozumenko-Development-auqanautica`, `OLD=$WORK/oldpack/apps/vscode-extension/resources/octobots-pack/tokenomics` (the v56 tokenomics, see below).

- Node >= 20 and `pnpm install && pnpm build` done in $OCTO (octoshell checkout on the mission branch).
- Solo is checked out at $SOLO. Run the CLI cases from a disposable worktree: `git -C $SOLO worktree add $SOLO/.claude/worktrees/qa-m1 HEAD` (it unwinds to solo's own slug; artifacts are written into the worktree). Remove it afterwards. NEVER run collectors from $SOLO itself: its committed .octobots/tokenomics/ must stay byte-identical (`git -C $SOLO status --short .octobots/tokenomics` is empty before and after).
- Transcript roots for solo's slug: the home root `$HOME/.claude/projects/$SLUG` and the legacy root of the MAIN checkout, `$SOLO/.claude/projects/$SLUG`. A worktree has no legacy root of its own: the collector always reads the main checkout's.
- Every tokenomics command passes `--project-dir` (agent shells reset the cwd between calls; a bare rollup.mjs would write octoshell's own runs.json), and rollup.mjs also gets `--no-gh` so compared runs are deterministic. collect.mjs merges into an existing raw/segments.jsonl, so a case that inspects a fresh collection first runs `rm -f .octobots/tokenomics/raw/segments.jsonl` (inside the worktree only).
- v56 tokenomics for before/after comparisons (TC-007): `mkdir -p $WORK/oldpack && git -C $OCTO archive origin/main apps/vscode-extension/resources/octobots-pack/tokenomics | tar -x -C $WORK/oldpack`.
- Work only on copies inside $WORK or inside the disposable worktree.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M1-AC1 | Collector reads ~/.claude/projects/<slug>, and only that repo's slug dir | TC-001 |
| M1-AC2 | Root precedence: --projects-dir > env > CLAUDE_CONFIG_DIR > ~ | TC-002 |
| M1-AC3 | Home + legacy roots deduped (more turns wins), rerun byte-identical | TC-003 |
| M1-AC4 | Extension report includes home-only sessions, own slug only; CLI/TS parity; worktree slug | TC-004, TC-009 |
| M1-AC5 | One attribution precedence in both rollups; campaign rows (work_item_level "campaign", parent_ref null, mission_id null); no mission row loses a segment | TC-005, TC-006, TC-007, TC-009 |
| M1-AC6 | prices.local.json survives refresh, upstream wins, kept on re-install, in prices.data.ts | TC-008 |
| M1-AC7 | Pack v57 everywhere | TC-010 |
| M1-AC8 | doctor.js treats ~/.claude/projects as the default; no <repo>/.claude advice | TC-011 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m1` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m1/evidence/`; the run report under `tests/m1/runs/`.

## Pre-existing records

- Home slug dir `$HOME/.claude/projects/-Users-arozumenko-Development-auqanautica`: 3 top-level sessions (117 jsonl incl. subagents), all home-only: 011deac1 (the live planning session, still growing), 138ca3b0, 39d8025a.
- Solo legacy root `$SOLO/.claude/projects/-Users-arozumenko-Development-auqanautica`: 6 other sessions (276MB) that today's extension already reads, so a non-zero solo report alone proves nothing.
- Octoshell legacy root `$OCTO/.claude/projects`: other projects' slug dirs (-Users-arozumenko-Development-analysta, -private-tmp, ...) next to octoshell's own.
- Unattributed campaign-level segments: `feat/edge-ops-ui` (28; campaign edge-ops-ui has 10 missions) and `campaign/emulator-arena-loop` (1; emulator-arena-loop has 7 missions).
- `chore/uwb-ranging-plan` (5; slug uwb-ranging-ingest-vendor-v01 NOT contained; needs a declared campaign tokenomics.branches).
- `campaign/sensor-assignment-uplift` (7): attributed today to sensor-assignment-uplift M1, whose mission.yaml:17 declares it in tokenomics.branches; it must stay there.
- uwb mission rows M1-M4 and M6 in solo's runs.json (5 rows; M5 is cancelled and has no row).
- Solo prices.json entries for claude-opus-5-5 / claude-sonnet-5-5 (the pack's own table lacks them).

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: flags confirmed against solo's collect.mjs on 2026-10-05: `--project-dir`, `--projects-dir`, env OCTOBOTS_TOKENOMICS_PROJECTS_DIR; rollup.mjs takes `--project-dir`, `--no-gh`, `--quiet`. QA re-checks against the ported files before running.
- A2: TC-004's Extension Dev Host half is manual (not Playwright-drivable); its CLI half runs apps/vscode-extension/scripts/qa/tokenomics-report.mjs (T1.2).
- A3: segment counts (28, 1, 5, 7) are from 2026-10-05 and may have grown; QA states the actual numbers.
- A4: step 4 of the precedence (worklog) is new in rollup.mjs, so a mission row may GAIN segments compared with the v56 rollup; it must never lose one (TC-007).
