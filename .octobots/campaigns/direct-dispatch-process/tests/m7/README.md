# Suite: direct-dispatch-process-m7

Functional cases for **M7 - Pack updates reconcile locally changed skills with an agent**, campaign `direct-dispatch-process` (octoshell). 17 cases (12 cli, 4 unit, 1 ui), authored from the mission acceptance criteria (M7-AC1..AC8, numbered in board order) before the mission is built. Every case names a pre-existing record: copies of the real solo and octoshell workspaces and solo's real forks and git history, never a self-made fixture (a derived or synthetic input says so). Only SKILL.md is protected by a reconcile; the cases check that the rest of each skill's directory installs.

## How to run

Run the cases in numeric order from the octoshell checkout on the mission branch (`feat/direct-dispatch-process-m7`). Each case file holds its exact commands and an Expected Final State; the runner records PASS / FAIL / BLOCKED / UNREACHABLE per case with evidence and writes `runs/RUN-YYYY-MM-DD-NNN.md` (evidence under `evidence/`). After each case record the result on the board: `node $PACK/skill/mission-planner/scripts/set-test-status.js <TC file> <pass|fail|blocked> --evidence <runs/RUN file>` (available once M6 ships; until then edit the frontmatter `status`/`last_run` by hand). Result words map to status: PASS -> pass, FAIL -> fail, BLOCKED -> blocked, UNREACHABLE -> blocked with the reason in the RUN file; a manual (F5) execution is noted as manual in the RUN file.
A case that runs a vitest suite runs `pnpm --filter <pkg> exec vitest run <package-relative path> --reporter=verbose` and needs at least 1 test passed in that file (never `pnpm ... test -- <name>`). QA harnesses are the committed scripts under `apps/vscode-extension/scripts/qa/` (campaign notes § Test conventions).
Cases of kind `ui` are manual Extension Development Host (F5) sessions (VS Code is Electron, not drivable by Playwright MCP; no @vscode/test-electron harness), recorded as manual with screenshots.
TC-011, TC-012, TC-013 and TC-015 are behavioural micro-tests, following M2 TC-009's convention: 5 fresh sub-agents (Agent tool, `model: sonnet`, foreground), an identical prompt, each on its own fresh copy, scored programmatically and then read by hand. They cost tokens and are non-deterministic; TC-013 (escalation) passes only 5/5 and TC-015 (its round trip, on three of TC-013's copies) only 3/3.
TC frontmatter follows M4's TC format contract (M4 mission notes): id, title, mission, covers, kind, status, optional last_run; other keys (priority, size) are allowed.

## Prerequisites

Shell variables used in the cases: `SOLO=/Users/arozumenko/Development/auqanautica`, `OCTO=/Users/arozumenko/Development/octoshell`, `PACK=$OCTO/apps/vscode-extension/resources/octobots-pack`, `WORK=$(mktemp -d)`, `IP="node $OCTO/apps/vscode-extension/scripts/qa/install-pack.mjs"`, `SCRATCH=<the planning scratchpad holding reconcile-spike/base-rules.mjs>` (TC-005's contrast step only; BLOCKED-free if absent: skip that step and say so).

- `pnpm install && pnpm build` in $OCTO on the mission branch.
- Base recovery rule 2 reads the workspace's own git history, which a `cp -R` copy does not carry. Cases that need it make a git copy that shares solo's object store read-only and writes nothing to solo:
  `gitcopy() { git clone -q --shared --no-checkout "$SOLO" "$WORK/$1" && git -C "$WORK/$1" checkout -q HEAD -- .claude .octobots && cp -R "$SOLO/.claude" "$SOLO/.octobots" "$SOLO/CLAUDE.md" "$SOLO/AGENTS.md" "$WORK/$1/"; }`
  (the final `cp -R` puts solo's current, possibly uncommitted, files on top). A plain `cp -R` copy is used where a case says so.
- The harness: `$IP <workspace> [--pack-root <dir>] [--local-changes=reconcile|overwrite|keep] [--pack-version <n>]` prints `{before, deviations, result, after}` (result incl. `pending` and `kept`) and writes `<n> skill(s) need reconcile` to stderr. The default is reconcile (the non-interactive choice); `--pack-version` is QA-only.
- The primer is run as a hook runs it: `echo '{"hook_event_name":"SessionStart"}' | CLAUDE_PROJECT_DIR=<copy> node <copy>/.octobots/hooks/primer.mjs`.
- Baseline before touching anything: `git -C $SOLO status --short`, `git -C $OCTO status --short`, `shasum -a 256 $SOLO/CLAUDE.md $SOLO/AGENTS.md` and `(cd $OCTO && find .claude -type f | sort | xargs shasum -a 256)` (octoshell's .claude is gitignored, so git status cannot see a sub-agent writing there) recorded; they must be the same after.
- The harness always reads the store from apps/vscode-extension/resources/shipped-skills.json.br, also when `--pack-root` points at a pack copy (TC-012, TC-013, TC-016).

## AC to test case map

| AC | Summary | Test cases |
|----|---------|------------|
| M7-AC1 | Deviation detection by one shared marker rule against the brotli store; packStatus fields; `<N>+local` reconciled only against the current pack file | TC-001, TC-002, TC-004, TC-006, TC-014, TC-017 |
| M7-AC2 | Base recovery rules 1-5 (reconciled-from, workspace git, earliest declared, closest, none) | TC-001, TC-005, TC-014 |
| M7-AC3 | installPack reconcile (default) / overwrite / keep; only SKILL.md protected; staging, pending.json shape, idempotency, logs never deleted, carried-over questions | TC-001, TC-002, TC-003, TC-004, TC-014, TC-016, TC-017 |
| M7-AC4 | Modal Reconcile / Overwrite / Keep mine; no agent started; activation prompt quiet while pending or kept | TC-007 |
| M7-AC5 | install-pack.mjs --local-changes, --pack-version, JSON and stderr contract | TC-001, TC-003, TC-014, TC-016 |
| M7-AC6 | primer.mjs's one health line (reconciles first, workflows/, config dir; acks skipped); doctor.js and validate.js list pending | TC-008, TC-009, TC-015 |
| M7-AC7 | octobots-doctor skill text incl. the escalation round trip and the retired-skill done condition; pack-reconcile.mjs list/done | TC-004, TC-010, TC-011, TC-013, TC-015 |
| M7-AC8 | Real reconcile on solo's forks, no-churn case, escalated xfail conflict (5 reps each), answered escalation (3 reps) | TC-011, TC-012, TC-013, TC-015 |

## Shared preconditions

- A clean checkout of octoshell on `feat/direct-dispatch-process-m7` with dependencies installed and built.
- M2 has landed on the campaign branch: the pack's mission-execution and mission-completion-gate are the upstreamed v57 text (TC-011's upstream).
- Cases operate on copies in `$WORK`; the originals are never modified.

## Pre-existing records

- solo's real forks `.claude/skills/mission-execution/SKILL.md` and `.claude/skills/mission-completion-gate/SKILL.md` (`version: 57-local`, committed in f2e7812d).
- solo's git history: commit 7de91fef holds the shipped v56 files (mission-execution 9af2c928b8310dddbff78f015f00264251592ca727ae1d07741f363bd4a9c523, mission-completion-gate 008de10a952f5afeb5e85fb02cf1814179cd516d537bf57016b3e071105dd4cc).
- the first v57 build of the pack, octoshell commit 800c62c (the v56 text plus the version line).
- solo's real `.claude/skills/workflow-designer` (v56, byte-identical to the shipped file) and create-team.js.
- solo's CLAUDE.md (DSN guard, rule 11 at :226 `Override BOTH DSNs`) and AGENTS.md: must stay byte-identical through a reconcile.
- octoshell's real `.claude` (v56, all shipped files) and its 5 workflows/ folders (octograph m3..m7).
- The anchors solo's rules must keep after a reconcile: campaign notes § Real-data notes, bullet 'Skill fork bases'.

## Data policy

Every case's "Real data" section names the pre-existing record that backs it. A criterion proved only on data the QA agent created is NOT passed. Where no pre-existing record can exercise a criterion, say UNREACHABLE (recorded, with the reason) instead of substituting a fixture. Derived inputs (an appended line, a relabelled marker) and synthetic ones (TC-013's upstream) start from named real files and say so.

## Assumptions to confirm

- A1: TC-011's checks assume M2's upstreamed skills keep solo's anchor phrases where solo's text was not project-specific; if T2.1/T2.2 reworded an anchor, QA records the new phrase from the M7-branch pack and greps for whichever side DECISIONS.md says was kept.
- A2: TC-013's awk edit anchors on the green-definition line of the M7-branch mission-completion-gate (M2-AC6 requires it to state 0 xfailed); if the count is not 1, the case is BLOCKED until the edit is re-anchored (the conflict, not the wording, is what is under test). The planted conflict is on a rule solo ADDED (absent from base v56), so it is a two-sided change under M7-AC7, not 'upstream only'.
- A3: the micro-tests use `model: sonnet` (the cheaper model an install-time session is likely to run); a stronger model passing does not stand in for it.
