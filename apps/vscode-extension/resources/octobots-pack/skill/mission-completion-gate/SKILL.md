---
name: mission-completion-gate
description: Use when an Octobots mission is marked `done` (the mission-gate PostToolUse hook fires this) — the blocking, agent-driven completion gate that must pass green before a mission is truly complete. The orchestrator dispatches sub-agents (never the Workflow tool) for the tests+coverage pipeline, a black-box QA pass against acceptance criteria, and a critical tech-lead review that challenges the devs, then merges/completes only on green. Not for a single task (tasks gate inside mission-execution); this is the mission-level gate.
version: 57
---

# mission-completion-gate

The **blocking** gate that runs when a mission flips to `done`. The project's mechanical gate
(linters, type-checks, test suites, new-code coverage) is necessary but **not
sufficient** — this gate adds the agent pipeline a git hook can't: black-box QA
against acceptance criteria and a critical whole-branch review. A mission is not
done until this gate is green.

> Triggered automatically by `.octobots/hooks/mission-gate.mjs` (PostToolUse on
> `set-status.js … done` for an `M<n>` mission). You can also run it by hand
> before marking a mission done.
>
> Note the layering (see mission-planner, *Setting status on a mission*): flipping a mission `done`
> with `set-status.js` does **not** drive the app's displayed mission status — that comes from the
> run lifecycle — but it **does** fire this hook. Flipping the mission `done` is therefore the
> intended way to launch this gate, not a no-op; don't skip it thinking the marker is "ignored".
>
> The hook fires only on a **real transition** to `done`: re-running `set-status.js … done` on a
> mission that is already `done` prints `unchanged` and launches nothing. To recover a gate that was
> skipped, run this skill by hand, or flip the mission to `executing` and then `done` again.

## Hard rules (non-negotiable)

- **Blocking.** If any phase fails, the mission is NOT done. Fix, re-verify, and
  only then leave it `done`. Never rationalize skipping the gate.
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
   Verdict: `{"green":bool,"coveragePct":n,"failures":[…],"blocked":bool}`.
   **Green means 0 failed, 0 xfailed or todo, and no skip without a stated environmental reason.** An
   `xfail`, a `todo` or a bare `skip` is a parked defect, not a pass. It is fixed where the error
   actually is, in code or in the test, before the gate goes green, unless the user explicitly signs
   it off.
   Run the full suite on the project's **fast lane** and run coverage **once, on the coverage lane
   only**. Read the project's declared test lanes (`AGENTS.md § Test lanes`; where a project has not
   declared them yet, use the project's documented commands in its `CLAUDE.md` / `AGENTS.md`). Brief
   the agents with those commands by name, never with a command of your own.
   Where octograph is installed, `impact --diff`'s `tests that historically move with this` section
   feeds this question directly. A suggested test that the coverage run never exercised is worth a
   look before calling coverage sufficient.
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
4. **Tokenomics capture (non-blocking)**: dispatch a general-purpose agent (`model: sonnet`), or run
   it in the main loop, since it is two commands with no judgment involved:
   `node .octobots/tokenomics/run.mjs` and `node .octobots/tokenomics/backfill-worklog-sha.mjs`.
   Report this mission's `runs.json` row and whether its authored sizing is present. Commit the
   refreshed `.octobots/tokenomics/` artifacts. See § *Tokenomics capture* below. **Never blocks.**
5. **Merge / complete**: only when phases 1–3 are all green. Then check off the mission-level
   acceptance criteria on the board and leave the mission `done`. **Post the gate results** (suites
   and coverage %, the black-box QA verdict per criterion with its backing record, the review
   outcome) wherever the project mirrors its missions: a GitHub issue, a Jira ticket, or the
   mission's own `description` field if there is no external tracker. Each gate run appends its
   outcome, so the mission carries its verification history. See `mission-planner`
   (§ *External systems*).

When any phase is blocked, relay the findings, have the right dev fix them, and re-run from the
blocked phase. Do not leave the mission `done` on a red gate.


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
- **Write `## QA verification` into the task and mission `notes`** through `entity-io.mjs`
  (`loadEntity`/`dumpEntity`, never raw appended text): the verdict, the RUN file, per criterion the
  pre-existing record and the observed value, and every TC that is not `pass` with its reason.
- **Tick exactly the criteria that have evidence.** A ticked criterion with no matching line in
  `## QA verification` is a defect; a criterion with a BLOCKED or UNREACHABLE case behind it stays unticked.
- **Statuses are written by hand for now.** Edit each TC's frontmatter `status` (and `last_run`:
  `{date, evidence: <RUN file>}`) by hand, per the TC format contract in `mission-planner`. This is the
  single seam a status-writing script will replace; nothing else in this block changes.

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
