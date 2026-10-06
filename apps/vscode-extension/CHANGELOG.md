# Changelog

## 0.1.1

Octobots pack unchanged at v57, so a workspace already on v57 is not prompted to reinstall.

### Test-case panel

- **Test cases open in their own panel.** It shows the header, the acceptance criteria the case
  covers, the rendered body and an "Open source file" link to the raw markdown.
- **Status dropdown.** Choosing a status writes it the way `set-test-status.js` does and records
  `last_run` as the date only, with no evidence. It never overwrites a status that was changed
  outside the panel since it was loaded; reload and choose again.
- **Legacy test cases.** An older-format case can still have its status set, and the panel points
  you at `--migrate` to bring it to the current format.
- **Single click opens the panel.** A single click on a test case in the sidebar or in the mission
  panel now opens this panel; the raw file is one click away through "Open source file".

### Sidebar

- **Status-coloured Tests icons.** The Tests node and each mission's Tests group take the colour of
  their worst result, and a blocked test is now orange, matching its leaf.

### Internal

- The `qa-env` test no longer flakes, and turbo's strict environment mode passes the board-copy and
  test variables through, so a cached test run reflects the real environment.

## 0.1.0

Octobots pack v57. This release removes the Workflow feature end to end and replaces it with
direct sub-agent dispatch.

### Read this first: legacy `workflows/` folders

**Every release from commit a192780c through 0.0.51 DELETED any legacy
`workflows/<slug>/workflow.md` on every activation.** The migration (`migrateLegacyWorkflows`)
derived a `runs.jsonl` from the file's `## Runs` section and then permanently removed
`workflow.md`. If any of those releases ran in your workspace, it deleted each `workflow.md` it
found, and git history holds the only copy.

**0.1.0 no longer touches `workflows/` at all.** A leftover `workflows/` folder is ignored by the
board, and `validate.js` and `doctor.js` warn that it is no longer read.

### Removed commands

These commands no longer exist. A keybinding you bound to any of them now reports
"command not found":

- `octoshell.newWorkflow`
- `octoshell.deleteWorkflow`
- `octoshell.openWorkflowById`

The Workflow tree nodes, the Workflow editor panel and its diagram are gone too.

### Pack v57 and upgrading

The pack is versioned as one unit and is now at v57. When you install or update it in a workspace
where you edited a skill locally, the prompt offers three choices:

- **Reconcile** (default): leaves your live skill alone and stages the base, your version and the
  new upstream version under `.octobots/pack-updates/`. The next agent session is told to run the
  `octobots-doctor` skill, which merges the three and records its decisions.
- **Overwrite**: replaces your edit with the pack's text, after saving yours as
  `overwritten-local.md`.
- **Keep**: keeps your edit and remembers the choice while the file is unchanged.

`packStatus` compares integers only, so a workspace that already took an intermediate v57 install
will not be prompted again. Re-run "Octobots: Install Octobots Pack" there.

### Changes since 0.0.51

- **Tokenomics.** Collection and rollup read one transcript root rule, price models that upstream
  does not list from a local `prices.local.json`, and attribute cost per mission and task more
  accurately; `verify` gates cost only over models it can price.
- **Direct dispatch.** `mission-execution` runs a mission by having the orchestrator dispatch one
  sub-agent per phase; the completion gate runs the same way and the session hooks confirm status
  flips. The workflow design skill and the workflow authoring and run-logging scripts (with their
  vendored parser) are retired from the pack and the installer. Support
  for the Workflow tool is removed.
- **Workflow removed from the extension.** The Workflow entity is gone from `@octoshell/board`;
  `validateBoard` warns about a leftover `workflows/` folder. Detail views no longer save stale
  text over newer values.
- **Test cases.** A mission's `tests/` folder is scaffolded and linked by `add-tests.js`;
  `validate.js` warns on a missing tests pairing or a malformed test case; the planner authors
  tests with the mission, and the gate and last-task QA run them on real data.
- **Plan review and agent-ops guards.** A mission cannot start until a plan review is recorded
  (`set-status.js`, and a confirm dialog in the extension); the planner and execution skills carry
  server and timeout rules; a config-driven `qa-env.mjs` guards the QA database; `scan-parked.js`
  and the doctor flag parked tests and a missing test-lane declaration in `AGENTS.md`.
- **Test cases on the board.** `TestCase` is a board entity with AC coverage; a Tests node in the
  sidebar, a mission Tests panel and a campaign test summary show status and coverage; results are
  written with `set-test-status.js`.
- **Pack-updates reconcile and `octobots-doctor`.** A store of every shipped SKILL.md supplies
  merge bases; installs detect local deviations and offer Reconcile, Overwrite or Keep; the primer,
  `validate.js` and `doctor.js` surface a pending reconcile; the new `octobots-doctor` skill
  performs the merge.
