---
name: mission-completion-gate
description: Use when an Octobots mission is marked `done` (the mission-gate PostToolUse hook fires this) — the blocking, agent-driven completion gate that must pass green before a mission is truly complete. Runs the tests+coverage pipeline, a black-box QA pass against acceptance criteria, and a critical tech-lead review that challenges the devs, then merges/completes only on green. Not for a single task (tasks gate inside mission-execution); this is the mission-level gate.
version: 28
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
2. **QA — black-box (Sage)** — input is **only** the mission's acceptance criteria
   + the BA spec. Sage checks each criterion as pass/fail with observable
   evidence (behavior, endpoints, artifacts), **without reading code**. Ambiguity
   → Sage asks **Alex**. Output: per-criterion verdict → handed to **Rio**.
3. **Critical review (Rio)** — Rio reviews `git diff <base>...HEAD` — where `<base>` is the
   branch the mission was cut from (the campaign branch when it lands atomically, else `main`),
   the **same base the coverage step measures against** — with a security
   lens, then interrogates Py/Jay against the criteria. Returns
   `{blocking:[…], nits:[…]}`. Each blocking finding → dev addresses it **+ adds
   the regression test that would have caught it** → Sage re-verifies the affected
   criterion (still black-box).
4. **Tokenomics capture (non-blocking)** — run
   `node .octobots/tokenomics/collect.mjs` and commit the refreshed
   `.octobots/tokenomics/` artifacts (`raw/segments.jsonl`, `runs.json`,
   `report.html`). See § *Tokenomics capture* below. **Never blocks**: this is
   analytics, and the gate must not fail a correct mission over it.
5. **Merge / complete** — only when 1–3 are all green. Then check off the
   mission-level acceptance criteria on the board and mark it `done` for real.
   **Post the gate results** (suites + coverage %, black-box QA per-criterion
   verdict, review outcome) wherever the project mirrors its missions — a GitHub
   issue, a Jira ticket, or the mission's own `## Description` if there is no
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
const { missionId, criteria, baseBranch = 'main' } = args   // criteria: [{id, text}]

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
  `Return blocking vs nits.`,
  { agentType: 'tech-lead', phase: 'Review', schema: REVIEW_SCHEMA })
if (review.blocking.length) return { blocked: 'review', review }

phase('Tokenomics')   // non-blocking: analytics never fails a green mission
const tokenomics = await agent(
  `Run \`node .octobots/tokenomics/collect.mjs\` at the repo root, then report the row ` +
  `for mission ${missionId} from .octobots/tokenomics/runs.json (cost, tokens, turns, ` +
  `dispatches, net_loc) and whether its authored sizing (effort_days/size_tshirt) is ` +
  `present. Commit the refreshed .octobots/tokenomics/ artifacts. If anything fails, ` +
  `report it and continue — do NOT block.`,
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
node .octobots/tokenomics/collect.mjs        # collect -> rollup -> render
```

Produces, under `.octobots/tokenomics/` (all committed):

| Artifact | What it is |
|---|---|
| `raw/segments.jsonl` | Durable per-(session × agent × branch) token records. The thing that survives transcript pruning — append-only, idempotent. |
| `runs.json` | One schema-conformant row per mission + the segment header. Costs re-priced from raw tokens on every run. |
| `prices.json` | Cached LiteLLM price table (verbatim). Refresh occasionally with the pack's price-refresh command; the pipeline itself never fetches. |
| `report.html` | Self-contained analytics report, rendered from `runs.json` alone. |

Missions are matched to segments through the **branch name** (`feat/<campaign>-m<n>-…`),
so the existing branch convention is what makes attribution work. A mission may
override it explicitly (see below).

**Authored fields — the one thing the pipeline cannot derive.** Effort is the
rubric's sizing key and exists nowhere in a transcript. Declare it on the board,
at planning time, in an optional `## Tokenomics` block in `mission.md`:

```markdown
## Tokenomics
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
- **`code-review` / `requesting-code-review`** — the review mechanics Rio uses in
  phase 3.
- Mechanical gate: whatever the project runs pre-commit and in CI (linters,
  type-checks, suites, new-code coverage). This skill never replaces it.
