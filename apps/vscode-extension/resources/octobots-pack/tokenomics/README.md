# Factory tokenomics

Measures what this factory actually costs to run: tokens, dollars, effort and
code output **per mission**, collected from Claude Code session transcripts and
rendered to a self-contained HTML report.

Output conforms to the EPAM *AI Factory Run Submission* schema v1.0 —
`stop: implementation`, `owner_group: dev`, one row per Octobots **mission**.

```
node .octobots/tokenomics/run.mjs                    # collect -> rollup -> render (idempotent, safe to re-run)
node .octobots/tokenomics/render.mjs                 # re-render report.html from runs.json only
node .octobots/tokenomics/update-prices.mjs          # refresh the cached price table (occasional; commit it)
node .octobots/tokenomics/selftest.mjs               # run the pipeline against a synthetic project
node .octobots/tokenomics/verify.mjs                 # cross-check totals against ccusage
node .octobots/tokenomics/backfill-worklog-sha.mjs   # fill merge SHAs deleted branches took with them
```

## Why it runs at the mission gate

Session transcripts live in `.claude/projects/` — **not in git**, ~80 MB per
session, pruned without warning. Once they're gone a mission's cost is
unrecoverable. So the `mission-completion-gate` skill runs this at phase 4, and
`raw/segments.jsonl` is committed as the durable record. Collect early, report
later — never the other way round.

It is **non-blocking** by design. The gate is a correctness gate; analytics must
never fail a correct mission. `run.mjs` exits 0 even when a stage fails.

## The three stages

| Stage | Script | Input | Output |
|---|---|---|---|
| 1. Collect | `collect.mjs` | `.claude/projects/**` transcripts | `raw/segments.jsonl` |
| 2. Rollup | `rollup.mjs` | segments + board + git + `gh` + `prices.json` | `runs.json` |
| 3. Render | `render.mjs` | `runs.json` **only** | `report.html` |

They are decoupled on purpose:

- **Collect** is pure derivation — no board, no git, no pricing. Records are keyed
  by `segment_id` and merged with what's on disk, so a re-run never loses a
  segment whose transcript has since been pruned.
- **Rollup** does all the joining and pricing. Costs are **recomputed from raw
  tokens on every run** under `prices.json` — token counts are canonical, dollars
  are derived and disposable. Refresh the price table and everything re-prices.
- **Render** never touches transcripts, so the report is reproducible from the
  committed `runs.json` alone — and works on any other factory's conformant file.

## How missions get their numbers

**Attribution is by branch name.** Every transcript record carries `gitBranch`,
and our branches already encode the work (`feat/edgeserver-auth-t4`,
`feat/edge-ops-ui-m9-t3`). The rollup matches the longest campaign slug in the
branch, then disambiguates by an `m<n>` token — or takes the single mission if the
campaign has only one. **Branch discipline is what makes this work**; a mission
can override it explicitly with a `branches:` line.

Work that maps to no mission (planning on `main`, detached `HEAD`,
campaign-wide branches) goes to the `unattributed` bucket — reported, never
dropped, and flagged in the report when it exceeds 10% of spend.

### Collect AFTER the mission PR exists

`net_loc`/`files_changed` are measured against the branch the mission was
actually cut from, and that base is resolved from the mission's **PR**
(`baseRefName`). With no PR to ask, the rollup falls back to `main` — which is
correct for a trunk-based mission and **wrong for a campaign on an integration
branch**, where it re-counts every previously-merged mission.

So the order at mission close is: **push -> open the PR -> `node .octobots/tokenomics/run.mjs`**.
Collecting before the PR exists inflates the row. It is not permanent damage —
`net_loc` is recomputed from git on every run, so re-running after the PR opens
corrects it (observed on edgeserver-microplus/M3: +10312/-73 across 90 files
before the PR, +2623/-72 across 28 after, matching the PR exactly).

### Derived automatically

`tokens{input,output,cache_read,cache_create}`, `tokens_by_model`, `primary_model`,
`models_used`, `turns`, `sessions`, `subagent_dispatches`, `orchestrator_cost_pct`,
`cache_read_share_pct`, `cost_api_equivalent_usd`, `net_loc`, `files_changed`,
`build_cost_usd`, `iterate_cost_usd`, `work_item_ref`, `parent_ref`, `work_item_brief`.

Two details that dominate correctness, both covered by `selftest.mjs`:

- **`requestId` dedupe.** Streaming re-emits the same `usage` payload across
  several records; without deduping, every token count roughly doubles.
- **Subagents are separate files**, and the tree is walked **recursively**. Plain
  Task subagents sit in `<session>/subagents/`; Workflow-tool agents nest under
  `<session>/subagents/workflows/wf_<id>/`. Since `mission-execution` leans
  heavily on workflows, those nested files are the large majority — a flat read
  finds ~10% of subagent work and silently reports `orchestrator_cost_pct: 100`.

Code churn is reported as **`lines_added` / `lines_removed`** alongside `net_loc`
(their difference). Net alone hides the shape of the work: a 600-added/580-removed
refactor and a 20-line feature both report net 20, and a cleanup reports negative.
`net_loc` stays because it is the rubric's lane signal; the split is what makes it
readable.

`net_loc`/`files_changed` come from `git diff --numstat` against the merge-base,
excluding lock/vendored/generated files. When the branch was deleted after merge
the rollup falls back to the PR's own totals via `gh`. A mission spans several
branches — task PRs target the *mission* branch, the mission PR targets `main` —
so the rollup prefers the PR whose base is `main`. Taking whichever PR was found
first under-reports a mission to one task's worth of work, and summing them all
would double-count (task PRs are already contained in the mission PR). PR totals
are also **unfiltered**,
so a scaffold-heavy PR can read high. The row records which was used in
`_octobots.diff_source`.

### Task churn does not sum to mission churn

A mission spans several branches. Each **task** PR is measured against the
*mission* branch; the **mission** PR is the merged result against `main`. Rebases,
squashes, conflict resolution, review fixes and integration commits land only in
the mission PR, and a line written in one task and rewritten in another counts
twice across tasks but once in the mission. On this repo the task sum runs ~2.2x
the mission total.

Both figures are correct at their own level. We do **not** reconcile them —
doing so would mean inventing an allocation. `_octobots.task_churn_reconciles` is
`false` to make that explicit, and the mission-level bucket reports no churn of
its own (its branch *is* the mission branch, so attributing the mission PR there
would restate the whole mission inside its own task list).

Use task churn to compare tasks with each other, and mission churn for the
mission's `net_loc`. Do not add task rows up and expect the mission total.

### Must be authored — the one thing no pipeline can derive

Effort is the rubric's sizing key (§3.3 is Effort-anchored) and appears nowhere in
a transcript. **`mission-planner` now requires it on every mission and every
task** — see that skill's *Estimation* section for the rubric (Effort bands, the
6-dim complexity score, the implementation lane, and the ±1 / ≥2-band
reconciliation rule).

Declare it on the board **at planning time**, in a `## Tokenomics` block — on
`mission.md` for the mission, and on each `tasks/<slug>/task.md` for its tasks:

```markdown
## Tokenomics
effort_days: 3
size_tshirt: M
complexity_score: 18
self_size: L
maturity: production
branches: feat/edgeserver-auth, feat/edgeserver-auth-t4
```

Missing blocks are a NOTE from `rollup.mjs` and a data-quality finding in the
report — never a silent zero. Since the rollup also computes the lane signals
(`net_loc`, `files_changed`, `subagent_dispatches`), a declared `effort_days` makes
the rubric's own estimation-drift audit possible.

## Prices

`prices.json` is a **cached copy of [LiteLLM's model-price catalog](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)**,
filtered to first-party Claude ids and stored **verbatim** — same field names,
same per-token units. There is no local price schema to drift out of sync, and
any number in it can be diffed straight against upstream.

```
node .octobots/tokenomics/update-prices.mjs           # refresh + report what moved
node .octobots/tokenomics/update-prices.mjs --check   # report drift, write nothing
```

Refresh it manually, occasionally, and commit the result. **The pipeline never
fetches** — that keeps collect/rollup/render offline, deterministic, and
reproducible: a run from six months ago re-prices identically unless someone
deliberately updates the table.

Two things this gets right that a hand-maintained table did not:

- **Cache writes are priced per TTL.** A 5-minute cache write bills at 1.25× input,
  a 1-hour write at 2×. Our sessions use the 1-hour cache heavily, so collapsing
  the two materially misstates cost. The collector records the split from
  `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`.
- **`cache_creation_input_tokens` is never priced directly** — it is the
  TTL-agnostic total of the same tokens, so pricing it alongside the split would
  double-count every cache write.

Where upstream omits a cache field, the documented multipliers apply (read 0.1×,
5m write 1.25×, 1h write 2× of input). A few legacy upstream entries report a
1-hour write *cheaper* than the 5-minute one, which cannot be right; the rollup
falls back to the documented 2× rather than importing a number known to be wrong.

## Cross-checking against ccusage

`ccusage` is a useful independent read on the same transcripts. Scope it to this
repo before comparing (it defaults to the global `~/.claude`, which covers every
project on the machine):

```
CLAUDE_CONFIG_DIR=<repo>/.claude npx ccusage@latest daily
```

Measured agreement on this repo's history:

| Field | Ours vs ccusage |
|---|---|
| `cache_read` | 100.2% |
| `cache_create` | 100.0% |
| total tokens | 100.02% |
| `input` | 84% — the gap is a Codex row ccusage includes and we don't (we read Claude transcripts only) |
| `output` | 50% — **ccusage double-counts; see below** |

**On output, we disagree deliberately.** ccusage's output total closely matches
`sum(usage.output_tokens) + sum(usage.iterations[].output_tokens)` over deduped
records. But `iterations` is a *per-attempt restatement of the same request*, not
additional generation — adding it to the top-level total counts the same tokens
twice. We count the top-level figure only. Cache reads dominate cost, so the
headline dollar figures still land close, but the output column should not be
expected to match.

If a future comparison diverges on *cache* or *total* tokens, suspect our
collector (a missed transcript location) before suspecting ccusage — that is
exactly how the `workflows/` gap above was found.

## Submitting

`runs.json` is the machine-readable submission and `report.html` the analytics
attachment. The `_octobots` key on each row is local diagnostics, not part of the
schema — strip it if a submission requires strict conformance.

Costs are **API-equivalent** (tokens × public list price), never billed amounts.
