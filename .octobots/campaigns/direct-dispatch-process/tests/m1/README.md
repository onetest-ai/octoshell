# Suite: direct-dispatch-process-m1

Functional cases for **M1 - Tokenomics reads real transcripts and attributes campaign branches**, campaign `direct-dispatch-process` (octoshell). 10 cases (8 cli, 1 ui, 1 unit), authored from the mission acceptance criteria (M1-AC1..AC7, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real octoshell and solo boards and transcripts, never a self-made fixture (a case that is a synthetic unit check says so).

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m1`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence screenshots under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand).
Cases of kind `ui` that need VS Code are manual Extension Development Host (F5) sessions: VS Code is Electron and not drivable by Playwright MCP, and the repo has no @vscode/test-electron harness. Record them as manual, with screenshots.
TC frontmatter: id, title, mission, covers (list of M<n>-AC<k>), kind (api|ui|cli|unit), status (draft|ready|pass|fail|blocked), optional last_run.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`.

- Node >= 20 and `pnpm install && pnpm build` done in $OCTO (octoshell checkout on the mission branch). `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`.
- Solo is checked out at $SOLO (/Users/arozumenko/Development/auqanautica). Run the CLI cases from a disposable worktree: `git -C $SOLO worktree add $SOLO/.claude/worktrees/qa-m1 HEAD` (it unwinds to solo's own slug). Remove it afterwards. NEVER run collectors from $SOLO itself: its committed .octobots/tokenomics/ must stay byte-identical (`git -C $SOLO status --short .octobots/tokenomics` is empty before and after).
- Real transcripts: ~/.claude/projects/-Users-arozumenko-Development-auqanautica (must exist and be non-empty). Real board: solo .octobots/campaigns/{sensor-assignment-uplift,uwb-ranging-ingest-vendor-v01}.
- Capture baselines BEFORE building the mission branch's changes where a case compares before/after (TC-007): run solo's current runs.json copy aside as $WORK/runs.before.json.
- `WORK=$(mktemp -d)`. Work only on copies inside $WORK.

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M1-AC1 | Collector scans only this repo's slug dir under ~/.claude/projects | TC-001 |
| M1-AC2 | Root precedence: --projects-dir / env > CLAUDE_CONFIG_DIR > ~ | TC-002 |
| M1-AC3 | Home + legacy roots deduped, rerun byte-identical | TC-003 |
| M1-AC4 | Extension report non-zero from home root; CLI/TS parity; worktree slug | TC-004, TC-009 |
| M1-AC5 | Campaign-level branches get a campaign row (mission: null) | TC-005, TC-006, TC-007, TC-009 |
| M1-AC6 | prices.local.json overrides survive refresh | TC-008 |
| M1-AC7 | Pack v57 everywhere | TC-010 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m1` with dependencies installed and built (see Prerequisites).
- Cases operate on copies in `$WORK`; the originals under $SOLO and $OCTO are never modified (git status of both is recorded before and after and must be equal).
- Evidence (command output, screenshots) is saved under `tests/m1/evidence/`; the run report under `tests/m1/runs/`.

## Pre-existing records

- Slug dir `~/.claude/projects/-Users-arozumenko-Development-auqanautica` (real Claude Code transcripts, hundreds of sessions incl. worktree and subagent sessions).
- 7 real segments on branch `campaign/sensor-assignment-uplift` (in solo runs.json 'unattributed').
- 5 real segments on branch `chore/uwb-ranging-plan` (slug `uwb-ranging-ingest-vendor-v01` NOT contained; needs declared branches).
- uwb-ranging-ingest-vendor-v01 M1..M6 mission rows in solo runs.json (must be identical before/after).
- Solo prices.json entries for claude-opus-5-5 / claude-sonnet-5-5 (the pack lacks them in its own table).

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Cases that are synthetic unit checks derive their inputs from named real files and say so.

## Assumptions to confirm

- A1: the pack collector flags are `--project-dir <dir>`, `--projects-dir <dir>` and env OCTOBOTS_TOKENOMICS_PROJECTS_DIR as in solo's collect.mjs; confirm against the ported file before running (TC-001..003).
- A2: TC-004's Extension Dev Host check is manual (not Playwright-drivable); the vitest half uses the real slug dir path injected into the roots resolver.
- A3: segment attribution counts are taken from the real runs.json at QA time; the numbers 7 and 5 are from 2026-10-05 and may have grown. QA states the actual numbers.
