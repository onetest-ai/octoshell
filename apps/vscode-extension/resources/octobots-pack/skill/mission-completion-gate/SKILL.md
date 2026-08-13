---
name: mission-completion-gate
description: Use when an Octobots mission is marked `done` (the mission-gate PostToolUse hook fires this) — the blocking, agent-driven completion gate that must pass green before a mission is truly complete. Runs the tests+coverage pipeline, a black-box QA pass against acceptance criteria, and a critical tech-lead review that challenges the devs, then merges/completes only on green. Not for a single task (tasks gate inside mission-execution); this is the mission-level gate.
version: 52
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

## Hard rules (non-negotiable)

- **Blocking.** If any phase fails, the mission is NOT done. Fix, re-verify, and
  only then leave it `done`. Never rationalize skipping the gate.
- **QA is black-box.** Sage (`qa-engineer`) verifies against the **acceptance
  criteria + spec only** — Sage is **never** handed the diff or the source, and
  **never reads the implementation**. Sage communicates with **Alex** (`ba`, to
  clarify criteria) and **Rio** (`tech-lead`, to hand off the verdict) — and with
  no one else. No dev contact.
- **Rio challenges the devs.** In review, Rio (`tech-lead`) reviews the whole
  branch diff, then **calls Py (`python-dev`) / Jay (`js-dev`) directly** and
  challenges each of their decisions **against the acceptance criteria**
  ("criterion N says X — your code does Y; defend it"). Devs justify or fix.
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

## The gate (one Workflow, phases with structured handoffs)

Run this as a single `Workflow`. Pass the mission id, its acceptance criteria
(from the board) and the mission's **base branch** as `args` — the base is the branch
the mission was cut from (a campaign branch, else `main`); it defaults to `main` when
omitted. Phases:

1. **Tests + coverage** — Py/Jay run the project's mechanical gate: linters,
   type-checks and full suites green **and** new-code coverage at or above the
   project's threshold (80% unless the project sets its own). Red → back to the dev,
   bounded fix loop, re-run. Structured result: `{green, coveragePct, failures}`.
   Where octograph is installed, `impact --diff`'s `tests that historically move with this`
   section feeds this question directly — a suggested test absent from the coverage run is
   worth a look before calling coverage sufficient.
2. **QA — black-box (Sage)** — input is **only** the mission's acceptance criteria
   + the BA spec. Sage checks each criterion as pass/fail with observable
   evidence (behavior, endpoints, artifacts), **without reading code**. Ambiguity
   → Sage asks **Alex**. Output: per-criterion verdict → handed to **Rio**.
3. **Critical review (Rio)** — Rio reviews `git diff <base>...HEAD` — where `<base>` is the
   branch the mission was cut from (the campaign branch when it lands atomically, else `main`),
   the **same base the coverage step measures against** — with a security
   lens, then interrogates Py/Jay against the criteria. Rio **fixes each blocking
   finding in place + adds the regression test that would have caught it**, and
   returns `{fixed:[…], stillOpen:[…], nits:[…]}`. Block on `stillOpen` only —
   then Sage re-verifies the criteria those fixes touched (still black-box),
   because a fix changed the code *after* Sage signed off on it.
4. **Tokenomics capture (non-blocking)** — run
   `node .octobots/tokenomics/run.mjs` and commit the refreshed
   `.octobots/tokenomics/` artifacts (`raw/segments.jsonl`, `runs.json`,
   `report.html`). See § *Tokenomics capture* below. **Never blocks**: this is
   analytics, and the gate must not fail a correct mission over it.
5. **Merge / complete** — only when 1–3 are all green. Then check off the
   mission-level acceptance criteria on the board and mark it `done` for real.
   **Post the gate results** (suites + coverage %, black-box QA per-criterion
   verdict, review outcome) wherever the project mirrors its missions — a GitHub
   issue, a Jira ticket, or the mission's own `description` field if there is no
   external tracker. Each gate run appends its outcome, so the mission carries
   its verification history. See `mission-planner` (§ *External systems*).

### Workflow template

```
export const meta = {
  name: 'mission-completion-gate',
  description: 'Blocking mission gate: tests+coverage, black-box QA, critical review, merge on green',
  phases: [
    { title: 'Tests+Coverage' }, { title: 'QA' }, { title: 'Review' },
    { title: 'Tokenomics' }, { title: 'Complete' },
  ],
}
// baseBranch = the branch this mission was cut from: the campaign branch when the
// campaign lands atomically, else `main`. The review diffs against it (three-dot from
// `main` would sweep in prior missions already merged into the campaign branch).
// `args` arrives as a JSON STRING, not an object — parse it once. Destructuring
// the raw global gives `undefined` for every field, and `baseBranch` then falls
// through to 'main' SILENTLY: the whole-mission review diffs against the wrong
// range and reports a clean gate. See workflow-designer § Body constraints.
const ARGS = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {})
const { missionId, criteria, baseBranch = 'main' } = ARGS   // criteria: [{id, text}]

phase('Tests+Coverage')
const tests = await agent(
  `Run the project's mechanical gate for mission ${missionId}. Report suites green ` +
  `and the new-code coverage %. If red or below threshold, fix (TDD) and re-run.`,
  { agentType: 'python-dev', phase: 'Tests+Coverage', schema: TESTS_SCHEMA })
if (!tests.green || tests.coveragePct < 80) return { blocked: 'tests/coverage', tests }

phase('QA')  // BLACK-BOX: criteria only, never the diff
const qa = await agent(
  `You are QA (Sage). Verify mission ${missionId} against ONLY these acceptance ` +
  `criteria — do NOT read the implementation/diff:\n${JSON.stringify(criteria)}\n` +
  `For each: pass/fail + observable evidence. Ambiguity → note a question for Alex (BA). ` +
  `Report to Rio (tech-lead).`,
  { agentType: 'qa-engineer', phase: 'QA', schema: QA_SCHEMA })
if (qa.criteria.some(c => !c.pass)) return { blocked: 'qa', qa }

phase('Review')
const review = await agent(
  `You are Rio (tech-lead). Review \`git diff ${baseBranch}...HEAD\` for ${missionId} with a ` +
  `security lens, then challenge Py/Jay's decisions against each acceptance criterion. ` +
  `Fix each blocking finding yourself, add the regression test that would have caught it, ` +
  `re-run the suites green, and push. Report findings as fixed vs still-open.`,
  { agentType: 'tech-lead', phase: 'Review', schema: REVIEW_SCHEMA })

// Gate on what is STILL OPEN, not on whether anything was found. A finding that Rio found,
// fixed and regression-tested is the gate working — failing the mission for it would punish
// the review for doing its job, and (worse) train the next reviewer to report less.
if (review.stillOpen.length) return { blocked: 'review', review }

// A fix changes the code AFTER Sage signed off, so Sage's verdict no longer covers it.
// Re-verify the affected criteria only — still black-box, still no diff, no source.
if (review.fixed.length) {
  const affected = [...new Set(review.fixed.map(f => f.criterion).filter(Boolean))]
  const recheck = await agent(
    `You are Sage. You already passed these criteria, then the tech lead fixed blocking defects ` +
    `in the code you verified. Re-verify ONLY these against the FIXED build, still black-box — ` +
    `do not read src/ or the diff:\n${JSON.stringify(affected)}\n` +
    `For each defect, prove the specific failure it describes can no longer occur.`,
    { agentType: 'qa-engineer', phase: 'Review', schema: QA_SCHEMA })
  if (recheck.criteria.some(c => !c.pass)) return { blocked: 'qa-recheck', recheck }
}

phase('Tokenomics')   // non-blocking: analytics never fails a green mission
const tokenomics = await agent(
  `Run \`node .octobots/tokenomics/run.mjs\` at the repo root, then report the row ` +
  `for mission ${missionId} from .octobots/tokenomics/runs.json (cost, tokens, turns, ` +
  `dispatches, net_loc) and whether its authored sizing (effort_days/size_tshirt) is ` +
  `present. Also run \`node .octobots/tokenomics/backfill-worklog-sha.mjs\` — it fills a ` +
  `merge SHA into worklog entries whose branch \`gh pr merge --delete-branch\` already ` +
  `deleted, which octograph's \`own\`/\`conflicts\` need for provenance-mode task<->file ` +
  `attribution; it detects octograph and skips cleanly when the workspace doesn't have it. ` +
  `Report how many entries it filled. Commit the refreshed .octobots/tokenomics/ artifacts, ` +
  `including worklog.jsonl if the backfill changed it. If anything fails, report it and ` +
  `continue — do NOT block.`,
  { phase: 'Tokenomics', schema: TOKENOMICS_SCHEMA })

phase('Complete')
return { blocked: null, tests, qa, review, tokenomics }
```

Define `TESTS_SCHEMA` / `QA_SCHEMA` / `REVIEW_SCHEMA` / `TOKENOMICS_SCHEMA` inline as small JSON Schemas
(see `mission-execution` for the handoff-schema style). On `blocked`, relay the
findings, drive the fix loop, and re-run — do not leave the mission `done`.

## Tokenomics capture (phase 4)

The gate is the **only** reliable moment to measure a mission's cost. Session
transcripts live in `.claude/projects/` — not in git, ~80MB per session, and
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
| `runs.json` | One schema-conformant row per mission + the segment header. Costs re-priced from raw tokens on every run. |
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

- **`mission-execution`** — the mission loop this gate sits on top of (one Workflow per mission,
  tasks sequenced inside it); same role model (Rio/Py/Jay/Sage/Alex/Max) and review machinery.
- **`knowledge-explorer`** — Sage uses it in phase 2 to size the risk surface: which paths the
  change is historically coupled to, and which of those the QA pass has not touched.
- **`code-review` / `requesting-code-review`** — the review mechanics Rio uses in
  phase 3.
- Mechanical gate: whatever the project runs pre-commit and in CI (linters,
  type-checks, suites, new-code coverage). This skill never replaces it.
