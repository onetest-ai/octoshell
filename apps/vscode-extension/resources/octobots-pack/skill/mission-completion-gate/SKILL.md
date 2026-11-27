---
name: mission-completion-gate
description: Use when an Octobots mission's tasks have merged and it is about to be marked done — set-status.js (and the status dropdown) refuses done until this gate's Gate checks and Completion gate records are green and current; also use when that refusal names this gate. The blocking, agent-driven completion gate. The orchestrator dispatches sub-agents (never the Workflow tool) for the tests+coverage pipeline, a black-box QA pass against acceptance criteria, and a critical tech-lead review that challenges the devs, records the results with gate-checks.mjs and gate-record.mjs, then ticks the criteria and marks the mission done only on green. Not for a single task (tasks gate inside mission-execution); this is the mission-level gate.
version: 65
---

# mission-completion-gate

The **blocking** gate that runs before a mission is marked `done`. The project's mechanical gate
(linters, type-checks, test suites, new-code coverage) is necessary but **not
sufficient** — this gate adds the agent pipeline a git hook can't: black-box QA
against acceptance criteria and a critical whole-branch review. A mission is not
done until this gate is green.

> **Gate first, then done.** Run this gate when the mission's last task has merged, before you mark
> the mission `done`. The order is: tasks merged → this gate (phases 1-4) → tick the criteria and
> mark the mission `done` (phase 5) → the mission PR.
>
> Marking a mission `done` is guarded (see mission-planner, *Setting status on a mission*).
> `set-status.js <campaign-dir> "<M<n> - name>" done`, and the extension's status dropdown, refuse
> until every task of the mission is `done` or `cancelled`, every mission criterion is ticked, every
> test case in `tests/m<n>/` is `status: pass`, and the latest `## Gate checks` and
> `## Completion gate` records are green and current. This gate writes those two records with
> scripts: `gate-checks.mjs` at the end of phase 1, and `gate-record.mjs` at the end of phase 3.
> Never write record text by hand. "Current" means the record's commit exists and no code outside
> the board (`.octobots/`) has changed since it, committed or not. A refusal names each failing check
> and the next step to take.

## Hard rules (non-negotiable)

- **Blocking.** If any phase fails, the mission is NOT done. Fix, re-verify, and
  only then mark it `done`. Never rationalize skipping the gate, and never pass `--force` to
  `set-status.js` to get past a red one: the override is the user's decision, recorded with its
  reason in the mission notes.
- **QA is black-box.** Sage (`qa-engineer`) verifies against the **acceptance
  criteria + spec only** — Sage is **never** handed the diff or the source, and
  **never reads the implementation**. Sage communicates with **Alex** (`ba`, to
  clarify criteria) and **Rio** (`tech-lead`, to hand off the verdict) — and with
  no one else, always through the orchestrator's relay. No dev contact.
- **Rio challenges the devs.** In review, Rio (`tech-lead`) reviews the whole
  branch diff and challenges each dev decision **against the acceptance criteria**
  ("criterion N says X — your code does Y; defend it"). Rio cannot call the devs
  itself: it returns the questions, and the orchestrator relays them to Py
  (`python-dev`) / Jay (`js-dev`) and brings back the answers. Devs justify or fix.
- **A fixed finding is not a failed gate.** Rio remediates in-flight — fix, plus
  the regression test that would have caught it. Block on findings that are
  **still open**, never on the mere existence of findings; then have Sage
  re-verify the criteria those fixes touched, still black-box. Blocking on any
  finding at all punishes the review for working, and teaches the next one to
  report less.
- **A gate that keeps finding premise defects is a signal, not a success.**
  This gate exists to catch **integration** defects — abstractions that
  duplicated across tasks, contracts that do not compose, end-to-end
  determinism. When it instead keeps finding *premise* defects (a boundary
  computed wrongly, a convention one module got backwards), the depth rule is
  not being applied upstream: those belong to the foundation task that emitted
  them, caught black-box at task level, before four more tasks built on the bad
  answer. Report it as a process finding alongside the code one.
- **New code ≥80% covered.** the project's new-code coverage gate must pass on
  changed lines vs the base branch, not repo-wide.
- **Merge/complete only on green.** Trust-but-verify substantive fixes in the
  merged code afterward.

## The gate (orchestrator dispatches one sub-agent per phase)

**Do not use the `Workflow` tool for this gate.** The orchestrator (main loop) runs the phases
itself, dispatching each one with the `Agent` tool **in the foreground, one at a time**, and reading
each verdict before deciding the next step. Collect the inputs first:

- the mission id and its acceptance criteria, read from the board with `show.js <mission-dir>`;
- the **base branch**, which is the branch the mission was cut from (a campaign branch, otherwise `main`);
- the mission feature branch, checked out in the one working tree.

Dispatch rules are those of `mission-execution` § *Dispatch rules*:
- pass `model:` explicitly (`sonnet` for tests and QA, `opus` for review);
- pin the cwd and scope searches to the subproject;
- run long commands in the foreground with `timeout: 600000`;
- end every brief with a required JSON verdict block, and treat a missing or unparseable verdict as **BLOCKED**.

Sub-agents cannot spawn sub-agents. Every "Sage asks Alex" or "Rio challenges Py" exchange is
therefore a **relay done by the orchestrator**: the agent returns its questions, the orchestrator
dispatches the addressee with them, and then hands the answers back in a follow-up dispatch.

1. **Tests + coverage**: dispatch `python-dev` or `js-dev`, whichever owns the changed code
   (`model: sonnet`). It runs the project's mechanical gate (linters, type-checks, full suites) and
   reports new-code coverage on changed lines vs `<base>`. The threshold is 80% unless the project
   sets its own. If the result is red, the same agent gets one bounded fix round, then re-runs.
   Verdict: `{"green":bool,"coveragePct":n,"failures":[…],"parked":{"unsigned":n,"allowed":n},"blocked":bool}`.
   **Green means 0 failed, 0 xfailed or todo, and no skip without a stated environmental reason.** An
   `xfail`, a `todo` or a bare `skip` is a parked defect, not a pass. It is fixed where the error
   actually is, in code or in the test, before the gate goes green, unless the user explicitly signs
   it off.
   Run the full suite on the project's **fast lane** and run coverage **once, on the coverage lane
   only**. Read the project's declared test lanes (`AGENTS.md § Test lanes`; where a project has not
   declared them yet, use the project's documented commands in its `CLAUDE.md` / `AGENTS.md`). Brief
   the agents with those commands by name, never with a command of your own.
   Also run the parked-test scan from the repo root:
   `node .claude/skills/mission-execution/scripts/scan-parked.js --json`. It lists the tests the repo
   parked instead of fixing (skip, todo, xfail, xit, xdescribe) under `unsigned`, and the
   conditional skips that state their reason under `allowed`. It exits 1 on any unsigned hit: phase 1
   is then not green, and the fix goes where the error actually is. A hit stays only when the user
   explicitly signs it off, as a line `<path>:<line> <who> <YYYY-MM-DD>` in
   `.octobots/parked-signoff.txt`; only the user signs a parked test off, and the agent never adds
   such a line itself. Exit 2 (not a git repository, or a bad `--root`) is a process finding, not a
   pass. Report both counts in the verdict.
   Where octograph is installed, `impact --diff`'s `tests that historically move with this` section
   feeds this question directly. A suggested test that the coverage run never exercised is worth a
   look before calling coverage sufficient.
   **Phase 1 ends with the recorded checks.** When the developer's verdict is green, commit its
   fixes, then run this from the repo root in the main loop, in the foreground with a Bash
   `timeout: 600000`: `node .claude/skills/mission-planner/scripts/gate-checks.mjs <mission-dir>`.
   It runs the coverage lane from `AGENTS.md § Test lanes` and the parked-test scan, then appends a
   `## Gate checks (<time>)` record to the mission notes. Exit 0 is green. Exit 1 is red: phase 1 is
   not green, so fix and run it again. Exit 3 is a refusal: either there are uncommitted tracked
   changes outside `.octobots/` (commit them first, because a record taken on uncommitted code can
   never be current), or the mission is not in a git repository. Without a coverage lane it warns and
   records only the parked-test scan. If the coverage lane runs longer than 10 minutes, ask the person
   to run the same command in a terminal.
2. **QA, black-box (Sage)**: dispatch `qa-engineer` (`model: sonnet`). Its input is **only** the
   mission's acceptance criteria and the BA spec. **Never** pass it the diff, file paths, or source.
   For each criterion, Sage records pass or fail with observable evidence (behaviour, endpoints,
   artifacts) and **names the pre-existing record that backed it**, where the project's `CLAUDE.md` /
   `AGENTS.md` asks for one. If a criterion is ambiguous, Sage returns `questions_for_ba`. The orchestrator dispatches `ba` with those
   questions, then re-dispatches Sage with the answers. Verdict:
   `{"criteria":[{"n":1,"pass":bool,"evidence":"…","record":"…"}],"questions_for_ba":[…]}`.
   Where the mission has a `tests/m<n>/` folder, Sage runs it as described in § *QA on the test cases*.
3. **Critical review (Rio)**: dispatch `tech-lead` (`model: opus`) with Sage's verdict, the
   criteria, and the range `git diff <base>...<mission-branch>`. The coverage step measured against
   the same base. Rio reviews with a security lens, walks each criterion to the code that implements
   it, and **fixes each blocking finding in place, adding the regression test that would have caught
   it**. Define "blocking" in the brief: an AC demonstrably unmet, a reproducible defect, or a
   security exposure with a PoC. To challenge a dev's decision, Rio returns `questions_for_devs`. The
   orchestrator dispatches `python-dev` or `js-dev` with them, then re-dispatches Rio once with the
   answers. Verdict: `{"fixed":[{"criterion":n,…}],"stillOpen":[…],"nits":[…],"questions_for_devs":[…]}`.
   **Block on `stillOpen` only.** If `fixed` is non-empty, re-dispatch Sage on **only the affected
   criteria**, still black-box: a fix changed the code after Sage signed off.
   Allow one review round and one fix round. Residue beyond that is filed as board bugs with an owner.
   **Phase 3 ends with the recorded result.** Once Rio's verdict is in and Sage has re-verified any
   fixed criteria, commit every fix. If phase 3 changed code, run `gate-checks.mjs` again as in
   phase 1: a Gate checks record stays current only while the code it checked is unchanged. Then
   record the outcome from the repo root:
   `node .claude/skills/mission-planner/scripts/gate-record.mjs <mission-dir> --verdict <green|red|pending-human> --qa <n>/<m> --still-open <k> [--note "<text>"]...`
   - `--qa <n>/<m>`: n of the mission's m acceptance criteria passed: those Sage passed black-box,
     plus any a person has checked (see `pending-human` below).
   - `--still-open <k>`: the number of blocking findings still in Rio's `stillOpen` after the fix
     round. Leftovers filed as board bugs are non-blocking by this gate's rule, so they do not count.
   - `--verdict green` only when phases 1-3 are green. The script refuses green unless n = m = the
     mission's criterion count and k = 0, and names the number that is off. Use `red` for a blocked
     gate.
   - `--verdict pending-human` when a criterion needs a person to check it (a manual or visual check
     the agents cannot make). Move the mission to `awaiting approval` and tell the user what to
     check. When the person has checked, record again with `--verdict green --qa <m>/<m>` (the
     person's check counts) and `--note "human check: <who>, <what was checked>"`. The latest record
     wins. Then continue: run phase 4 if it has not run yet, then phase 5 (tick the criteria, then
     mark the mission `done`). The mission does not stay in `awaiting approval`.
   - `--note` (repeatable) carries the phase results worth keeping, such as the coverage % and the
     Sage verdict per criterion.
   It appends a `## Completion gate (<time>)` record to the mission notes. Exit 3 is a refusal:
   uncommitted tracked changes outside `.octobots/` (commit first), no git repository, or a green
   verdict whose numbers do not match.
4. **Tokenomics capture (non-blocking)**: dispatch a general-purpose agent (`model: sonnet`), or run
   it in the main loop, since it is two commands with no judgment involved:
   `node .octobots/tokenomics/run.mjs` and `node .octobots/tokenomics/backfill-worklog-sha.mjs`.
   Report this mission's `runs.json` row and whether its authored sizing is present. Commit the
   refreshed `.octobots/tokenomics/` artifacts. See § *Tokenomics capture* below. **Never blocks.**
   It runs after the Completion gate record and before the mission is marked `done`. Its commit
   touches only `.octobots/`, so it leaves both records current.
5. **Merge / complete**: only when phases 1–3 are all green and both records are green. Only phase 5 ticks the mission's criteria: tick
   each mission-level acceptance criterion with
   `node .claude/skills/mission-planner/scripts/set-criterion.js <mission-dir> check <n>`, then mark
   the mission done with
   `node .claude/skills/mission-planner/scripts/set-status.js <campaign-dir> "<M<n> - name>" done`.
   If it refuses (exit 3), it names each failing check and the next step: take that step and try
   again. **Post the gate results** (suites
   and coverage %, the black-box QA verdict per criterion with its backing record, the review
   outcome) wherever the project mirrors its missions: a GitHub issue, a Jira ticket, or the
   mission's own `description` field if there is no external tracker. Each gate run appends its
   outcome, so the mission carries its verification history. See `mission-planner`
   (§ *External systems*). Only after the mission is `done` does its feature branch open the
   mission PR (see `mission-execution`, § *The mission gate*).

When any phase is blocked, relay the findings, have the right dev fix them, and re-run from the
blocked phase. Do not mark the mission `done` on a red gate; `set-status.js` refuses it anyway.

**Exit rule: at most two gate fix rounds.** Count them across phases. Stop patching early when a
re-run finds a blocker in code a gate fix itself wrote, in the same class as an earlier blocker.
In either case:

1. Dispatch `tech-lead` (`model: opus`) for a restructure brief: one source of truth for the
   disputed fact, plus the invariants the fix must keep.
2. The restructured diff gets the full gate again, from the first blocked phase. It counts as round
   1 again, once.
3. If that still fails, stop. Do not mark the mission `done`. Record the outcome with
   `gate-record.mjs --verdict red` and one `--note` per open blocker, and hand the blockers to the
   user. Do not run another fix round.

Gate fix loops on one defect class have run for hours in production, and rounds after the second
found no new bugs.


### QA on the test cases

This is the canonical statement of how QA runs a mission's functional test cases. `mission-execution`
§ *Mission QA: run the test cases live* carries the same rules for the mission's last task, and the two
must stay in step. Phase 2 and that last task are the same work done at two moments; the gate repeats
it on a fresh tree and is not satisfied by an earlier RUN file alone.

- **Run every TC in `tests/m<n>/`** (`.octobots/campaigns/<c>/tests/m<n>/TC-*.md`), on the real running
  system, by the execution mode each TC names (API/CLI calls, Playwright MCP for UI). Not a sample.
- **Write `runs/RUN-YYYY-MM-DD-NNN.md`** in that folder: one section per TC with the commands or steps
  actually run, the observed values and the result. `NNN` counts the runs of that day.
- **Record each TC as PASS, FAIL, BLOCKED or UNREACHABLE.** PASS -> `pass`, FAIL -> `fail`, BLOCKED ->
  `blocked`. UNREACHABLE (the pre-existing record the case needs does not exist) is written as status
  `blocked`, with the reason in the RUN file. Say UNREACHABLE rather than create the record and call it a pass.
- **Could not drive the browser or log in is BLOCKED**, never a pass and never a quiet skip. Report what was tried.
- **A manual execution** (a human or an F5 Extension Development Host session) is noted as manual in
  the RUN file; its status is still `pass`, `fail` or `blocked`.
- **Name the pre-existing record per criterion**: the real record each criterion was proved on. A
  criterion proved only on QA-created data is not passed.
- **The last task writes `## QA verification` into the task and mission `notes`** through `entity-io.mjs`
  (`loadEntity`/`dumpEntity`, never raw appended text): the verdict, the RUN file, per criterion the
  pre-existing record and the observed value, and every TC that is not `pass` with its reason. The
  gate writes its own `## Completion gate (<time>)` record into the mission `notes` with
  `gate-record.mjs` (its verdict, the QA and review counts, and `--note` lines for the phase results
  and the Sage verdict per criterion); that record refers to the last task's `## QA verification`
  block instead of repeating it, so the heading is never duplicated.
- **Tick exactly the criteria that have evidence.** A ticked criterion with no matching line in
  `## QA verification` is a defect; a criterion with a BLOCKED or UNREACHABLE case behind it stays
  unticked. The last task does not tick mission criteria: it ticks its own task's and records which
  mission criteria have evidence. In the gate, Sage's verdict marks which criteria have evidence and
  the ticking itself is phase 5's, once phases 1-3 are green.
- **Call `set-test-status.js` for every TC run.** It is installed at
  `.claude/skills/mission-planner/scripts/set-test-status.js` and writes the TC's frontmatter `status` and
  `last_run: {date, evidence: <RUN file>}` and nothing else (the body is untouched; a second identical call
  changes nothing). Map the result: PASS -> `pass`, FAIL -> `fail`, BLOCKED and UNREACHABLE -> `blocked` (the
  reason is in the RUN file). Example, after the run wrote `RUN-2026-10-06-001.md`:
  `node .claude/skills/mission-planner/scripts/set-test-status.js .octobots/campaigns/<c>/tests/m<n>/TC-003_<slug>.md pass --evidence .octobots/campaigns/<c>/tests/m<n>/runs/RUN-2026-10-06-001.md`
  (`--date YYYY-MM-DD` overrides today in UTC). Never edit the status or `last_run` by hand. A legacy TC
  (frontmatter with no `status`, `kind` or `mission`; `validate.js` says so) is first brought onto the format
  with `set-test-status.js <tc-file> --migrate`, which lists it as `unknown` and never touches the body.

## Tokenomics capture (phase 4)

The gate is the **only** reliable moment to measure a mission's cost. Session
transcripts live in `~/.claude/projects/<slug>` (or `$CLAUDE_CONFIG_DIR/projects/<slug>`), plus the
legacy repo-local `.claude/projects/<slug>` — not in git, ~80MB per session, and
pruned without warning. Once they are gone the mission's cost is unrecoverable,
so the gate captures it at completion rather than at reporting time.

```
node .octobots/tokenomics/run.mjs            # collect -> rollup -> render
```

The CLI ships with this pack and is installed into `.octobots/tokenomics/` — there is nothing to set
up, and it needs no dependencies beyond node. Two support scripts sit alongside it: `selftest.mjs`
(runs the whole pipeline against a synthetic board in both entity formats — run it if a report looks
wrong before believing the report) and `verify.mjs` (cross-checks the totals against `ccusage`).
Re-installing the pack refreshes the scripts and never touches collected artifacts.

Produces, under `.octobots/tokenomics/` (all committed):

| Artifact | What it is |
|---|---|
| `raw/segments.jsonl` | Durable per-(session × agent × branch) token records. The thing that survives transcript pruning — append-only, idempotent. |
| `runs.json` | One schema-conformant row per mission, plus one `work_item_level: "campaign"` row per campaign with campaign-level work (its own planning or declared branches), + the segment header. Costs re-priced from raw tokens on every run. |
| `prices.json` | Cached LiteLLM price table (verbatim). Refresh occasionally with the pack's price-refresh command; the pipeline itself never fetches. |
| `report.html` | Self-contained analytics report, rendered from `runs.json` alone. |

### Merge-SHA backfill — the same reasoning, applied to task<->file provenance

```
node .octobots/tokenomics/backfill-worklog-sha.mjs   # fills merged_sha where it can
```

`.octobots/hooks/work-log.mjs` appends a worklog line on every `set-status.js` active/done
transition — but `mission-execution` flips a task's status **before** merging its PR, so at the
only moment that line is written no merge SHA exists anywhere to record. Once the PR merges via
`gh pr merge --squash --delete-branch`, the branch the worklog recorded is gone: `branch ->
commits -> files` resolves to nothing for exactly the tasks worth attributing. The gate is the
first and only guaranteed **post-merge** checkpoint in this pack, which is why the backfill lives
in this phase rather than a new hook — the same "capture it now, because it is about to become
unrecoverable" reasoning phase 4 already runs on for session transcripts, applied to a second kind
of loss.

It resolves each unfilled entry's `branch -> merged PR -> mergeCommit.oid` via `gh` and rewrites
that line — idempotent (an entry that already carries `merged_sha` is left byte-unchanged), and it
never guesses (a branch with no merged PR is left alone). This is what lets octograph's `own` label
a task<->file answer `provenance` (a recorded fact) instead of `predicted` (a lexical guess) — see
`packages/graph`'s `attribution.ts` if this pack is installed alongside that package's source.

**Conditional, and non-blocking like every step in this phase.** octograph does **not** ship in
this pack — most workspaces installing Octobots will never have it — so the script first checks
for octograph's own footprint (an `octograph.yaml` at the repo root, or an existing graph
artifact) and skips cleanly, with no `gh` call and no write, when neither is present. That skip
costs nothing: the backfill is historical as well as idempotent, so a workspace that adopts
octograph later recovers every prior mission's provenance on its very next gate run. A `gh`
failure (offline, not installed, not authenticated) is reported and the script still exits 0 —
same rule as `run.mjs` above.

Missions are matched to segments through the **branch name** (`feat/<campaign>-m<n>-…`),
so the existing branch convention is what makes attribution work. A mission may
override it explicitly (see below).

**Authored fields — the one thing the pipeline cannot derive.** Effort is the
rubric's sizing key and exists nowhere in a transcript. Declare it on the board,
at planning time, in an optional `tokenomics` field in `mission.yaml`:

```yaml
tokenomics:
  effort_days: 3
  size_tshirt: M
  complexity_score: 18
  maturity: production
  branches: feat/<campaign>-m<n>, feat/<campaign>-m<n>-t<k>
```

`rollup.mjs` prints a NOTE for every mission missing this, and `report.html`
raises it as a data-quality finding. Everything else — tokens, cost, turns,
sessions, dispatches, orchestrator split, cache share, `net_loc`, `files_changed`,
build-vs-iterate — is derived with no human input.

**Hard rule: this phase never blocks.** If `run.mjs` fails (no transcripts, no
`gh`, offline), note it and complete the mission anyway. `run.mjs` exits 0 on
failure by design; pass `--strict` only when running it by hand to debug.

## Companions

- **`mission-execution`** — the mission loop this gate sits on top of (the orchestrator dispatches
  plan/build/review/QA sub-agents per task); same role model (Rio/Py/Jay/Sage/Alex/Max) and review machinery.
- **`knowledge-explorer`** — Sage uses it in phase 2 to size the risk surface: which paths the
  change is historically coupled to, and which of those the QA pass has not touched.
- **`code-review` / `requesting-code-review`** — the review mechanics Rio uses in
  phase 3.
- Mechanical gate: whatever the project runs pre-commit and in CI (linters,
  type-checks, suites, new-code coverage). This skill never replaces it.
