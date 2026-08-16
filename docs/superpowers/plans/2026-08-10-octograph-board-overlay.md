# Octograph Board Overlay (M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join the co-change graph to the Octobots board so `own` answers "which mission owns this module, and which criterion does this file exist to satisfy", and `conflicts` answers "is this decomposition clean" over a whole mission's tasks.

**Architecture:** Three layers. A **board reader** that gets missions, tasks and acceptance criteria from `@octoshell/board` (never a second parse of `.octobots`). An **attribution** layer that maps task ↔ file by one of three explicitly-labelled modes. A **query** layer implementing the two commands over the existing `Analysis`.

**Tech Stack:** TypeScript (NodeNext ESM, `strict`, `noUncheckedIndexedAccess`), Vitest, `@octoshell/board`. No new third-party dependencies.

## Global Constraints

- Relative imports carry `.js`. No new runtime dependency beyond the workspace package `@octoshell/board`.
- Deterministic: no clock, no randomness, every iteration order that reaches output explicitly sorted through `compare`.
- Order through `compare`, weights through `edgeWeight`, test paths through `isTestPath` — never a second spelling.
- Everything a consumer needs is re-exported from `src/index.ts`.
- Fixtures use `mkdtempClean()`.
- **`own` and `conflicts` require a board; every other command must keep working without one.**

---

## The finding that reshapes this mission

The spec (§ Input 3, A7) states that joining `worklog.jsonl` to git yields task ↔ file provenance
**"as a fact rather than an inference from branch-name convention."**

**That is false today, and the cause is our own workflow.** Measured 2026-08-10:

| | |
|---|---|
| worklog entries | 13 (12 carrying a `task` field) |
| distinct branches recorded | 13 |
| branches that still resolve to a commit | **0** |

`mission-execution` merges every task PR with `gh pr merge --squash --delete-branch`. The branch the
worklog records is deleted at the moment the task completes, so `branch → commits → files` resolves
to nothing for every finished task — the only ones worth attributing. Four branches appeared to
survive as `origin/…` refs; `git ls-remote` confirms the remote has none, so those were stale local
tracking refs and would vanish on the next `git fetch --prune`.

What *does* survive is the squash commit's subject, which by convention carries the task id
(`feat(graph): T3.5 — CLI and the pack bundle (#48)`). 19 distinct task ids are recoverable that way
on this repo — but **that is precisely the branch-name-convention inference the spec rejected**, and
it is lossy: T2.1 has no commit carrying its id.

### The recovery, and why there is no third mode

An earlier draft of this plan proposed a third `inferred` mode that would scan squash-commit
subjects for task ids. **That was wrong, and measuring killed it.** GitHub retains a merged PR's
`headRefName` and `mergeCommit` permanently, *including* for deleted branches:

```
$ gh pr list --state merged --json headRefName,mergeCommit
worklog branches: 13   recoverable via GitHub: 13
```

**All 13 lost branches resolve to a merge SHA.** So the history is recoverable as a **fact**, and a
lossy convention-scanner would have been built to rediscover, worse, what one backfill restores
exactly. The spec's two modes stand:

| Mode | Source | Trust |
|---|---|---|
| `provenance` | merge SHA in the worklog — backfilled once (Task 2), recorded at merge time thereafter | a fact |
| `predicted` | lexical match of criteria text against paths/identifiers (Task 3) | a guess |

The spec's rule — state which mode produced an answer, never blur them — is unchanged. **Do not
add a mode for commit-subject scanning.** If a branch has no PR and no recorded SHA, the honest
answer is `predicted`, not a guess dressed as evidence.

> Note what this costs: the backfill needs `gh` and network **once**. `own` itself stays offline —
> it reads SHAs from the worklog, never the network. A repo whose PRs are unreachable simply has
> fewer `provenance` answers and more `predicted` ones, which is the design degrading visibly.

> **This is a spec correction.** Amend § Input 3 and § A7 as part of Task 2, with the measurement
> above. Leaving the spec claiming "a fact" while the code labels the same answer `inferred` is the
> claim-outran-the-data defect this campaign exists to stop repeating.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/graph/src/board.ts` | **Create.** Read the board through `@octoshell/board`: missions, tasks, acceptance criteria, ids. No YAML parsing of its own. |
| `packages/graph/src/worklog.ts` | **Create.** Parse `.octobots/tokenomics/worklog.jsonl` tolerantly — a malformed line is skipped, never fatal. |
| `packages/graph/src/attribution.ts` | **Create.** `attribute()`: task ↔ file with an explicit `mode` per answer; the three-mode cascade. |
| `packages/graph/src/lexical.ts` | **Create.** tf-idf over identifier tokens: criteria text → candidate file paths. Deterministic, no embeddings. |
| `packages/graph/src/own.ts` | **Create.** The `own` query over `Analysis` + attribution. |
| `packages/graph/src/conflicts.ts` | **Create.** The `conflicts` query: predicted surface per task, pairs scored by summed nPMI. |
| `packages/graph/src/cli.ts` | **Modify.** Add `own` and `conflicts`, with a clear "needs a board" error. |
| `packages/graph/package.json` | **Modify.** Add `@octoshell/board` as a dependency. |
| `apps/vscode-extension/resources/octobots-pack/…` | **Modify (Task 2).** Record the squash SHA in the worklog at merge time. |

**Why depend on `@octoshell/board` rather than re-parsing `.octobots` here.** A second parser would
be a third spelling of the board schema — and the single most-cited finding this campaign produced
is `entity-io.mjs ↔ entity-schema.ts`: two implementations of one schema, no import edge between
them, whose divergence destroyed a decision record. Building a third would be this campaign
committing, in its own tool, the defect the tool exists to detect. `packages/board` does not depend
on `packages/graph`, so there is no cycle.

**The bundle risk this creates, and how it is discharged.** The pack ships an esbuild bundle that
must run under bare `node` with no `node_modules`. Adding a workspace dependency inlines all of
`@octoshell/board` into it. Task 1 must **measure the bundle before and after** and confirm it still
runs standalone. If it grows unacceptably, the fallback is to make `own`/`conflicts` library-only
(reachable from `index.ts` and M6's in-process bridge) and exclude them from the bundled CLI — a
scope decision for the owner, not something to decide silently while implementing.

---

### Task 1: Board and worklog readers

**Files:** Create `src/board.ts`, `src/worklog.ts`, `test/board.test.ts`, `test/worklog.test.ts`; modify `package.json`, `src/index.ts`.

**Interfaces produced:**

```ts
export interface BoardTask { id: string; name: string; mission: string; campaign: string; criteria: string[] }
export interface BoardView { tasks: BoardTask[]; missionOf: (taskId: string) => string | null }
export function readBoard(repoRoot: string): BoardView | null;   // null when there is no board

export interface WorklogEntry { sessionId: string; task: string | null; mission: string | null; branch: string | null; mergedSha: string | null; at: string }
export function readWorklog(repoRoot: string): WorklogEntry[];   // [] when absent
```

- [ ] **Step 1:** Failing test — `readBoard` returns `null` for a repo with no `.octobots/`, and every other command still works on that repo.
- [ ] **Step 2:** Failing test — `readWorklog` skips a malformed JSONL line and returns the valid ones. A truncated final line is the *expected* state of an append-only log a process died while writing; it must not throw.
- [ ] **Step 3:** Implement both over `@octoshell/board`'s `BoardModel`. Add the dependency. Rebuild `board` before typechecking `graph` (dependents read built `dist/`).
- [ ] **Step 4:** Measure the bundle: `pnpm --filter @octoshell/graph bundle`, record byte size before and after this task, and run the bundle under bare `node` from a directory with no `node_modules`. **Report both numbers.** A bundle that no longer runs standalone fails this task.
- [ ] **Step 5:** Green, export from `index.ts`, commit.

**Acceptance criteria (board):** given a repo with no `.octobots/`, `readBoard` returns null and `map`/`impact`/`drift`/`doctor` all still produce their normal output; given a malformed worklog line, `readWorklog` returns the well-formed entries and does not throw; the pack bundle still executes under bare `node` with no `node_modules` after the dependency is added, and its size change is reported.

---

### Task 2: Three-mode attribution, and recording the fact that is currently thrown away

**Files:** Create `src/attribution.ts`, `test/attribution.test.ts`; modify the pack's merge step and the spec.

**Interfaces produced:**

```ts
export type AttributionMode = "provenance" | "predicted";
export interface Attribution { task: string; files: string[]; mode: AttributionMode }
export function attribute(repoRoot: string, board: BoardView, log: WorklogEntry[]): Attribution[];
```

> **There is no merge-time write to add a field to.** `hooks/work-log.mjs:74` is
> `if (!command.includes("set-status.js")) process.exit(0);` — the hook fires only on a status flip.
> And `mission-execution`'s land step checks criteria off, flips `status`, *then* merges. So at the
> only moment the worklog is written, the PR is still open and no merge SHA exists anywhere.
> "Add `merged_sha` to the record" is therefore not a field addition; it needs a capture point that
> runs *after* the merge.
>
> **The capture point is the mission gate, not a new hook.** `mission-completion-gate` already has a
> non-blocking Tokenomics phase whose entire reason for existing is *capture the data now, because
> it is about to become unrecoverable*. Merge SHAs are the same class of data and have the same
> deadline. Reusing that phase costs one script call, needs no new hook trigger, and depends on no
> agent remembering to do it. A `gh pr merge` hook trigger was considered and rejected: it would
> need a second `gh pr view` call to learn the SHA the merge produced, adding a network round-trip
> to a hot path to capture something the gate can batch.

- [ ] **Step 1:** Write `scripts/backfill-worklog-sha.mjs` in the pack: for each entry with a `branch` and no `merged_sha`, resolve `branch → merged PR → mergeCommit.oid` via `gh` and rewrite the line. Idempotent — an entry that already has a SHA is untouched, a branch with no merged PR is left alone rather than guessed, and a `gh` failure exits 0 with a note rather than corrupting the log.
- [ ] **Step 2:** Wire it into `mission-completion-gate`'s Tokenomics phase alongside `tokenomics/run.mjs`, and say in the skill *why* it lives there. Bump the pack version. **Non-blocking, like everything else in that phase** — a missing SHA must never fail a green mission.

> **And conditional.** The pack ships to every Octobots workspace; **octograph does not ship in it.**
> The pack contains `hooks/`, `skill/` and `tokenomics/` — verified 2026-08-11 — so a workspace that
> installs Octobots has no octograph unless it installed it separately (that is what M5's `setup`
> exists for). A gate step that unconditionally backfills SHAs for a tool the workspace does not
> have is cost and noise in someone else's project.
>
> So the step **detects octograph and skips cleanly when it is absent** — no error, no `gh` call, no
> write. Skipping costs nothing: the backfill is *historical* and idempotent, so a repo that adopts
> octograph later recovers every prior mission's provenance on its first gate run. That property is
> what makes "skip when absent" safe rather than lossy, and it is worth stating in the skill text so
> nobody later "fixes" the skip into an unconditional run.
>
> **This cannot be verified by watching this mission's own gate.** The gate executes the *installed*
> `.claude/` copy, not `resources/octobots-pack/`, so a change to the shipped pack is invisible in
> this repo until the pack is reinstalled. The skip path needs a test, not an observation.

- [ ] **Step 3:** Run the backfill once against this repo and report how many entries it filled — **re-measure rather than citing this plan's numbers, which are already stale.**
- [ ] **Step 3:** Failing test — an entry carrying `merged_sha` attributes via `git show --name-only <sha>` and is labelled `provenance`.
- [ ] **Step 4:** Failing test — an entry whose `merged_sha` names a commit that is not in this repo (a force-push, a rewritten history) does **not** attribute and does not throw; it falls through to `predicted`. A recorded SHA is evidence only while it resolves.
- [ ] **Step 5:** Failing test — a task with no SHA is left for the lexical layer and labelled `predicted`; it is not silently dropped.
- [ ] **Step 6:** Implement. Resolve a recorded SHA, else defer to lexical. **No commit-subject scanning** — see the section above.
- [ ] **Step 7:** Amend spec § Input 3 and § A7: the branch join does not survive `--delete-branch`, and provenance comes from a recorded merge SHA instead. Include the 2026-08-10 measurement.
- [ ] **Step 8:** Green, commit.

**Acceptance criteria (board):** an entry with a resolvable `merged_sha` yields files labelled `provenance`; an entry whose `merged_sha` does not resolve in this repo falls through to `predicted` without throwing; a task with no SHA appears labelled `predicted` rather than being omitted; the backfill is idempotent, fills every worklog entry whose branch has a merged PR, and leaves the rest untouched; the pack records a merge SHA for every task PR merged after this task; the spec no longer claims the branch join yields provenance.

---

### Task 3: Lexical cold-start prediction

**Files:** Create `src/lexical.ts`, `test/lexical.test.ts`.

tf-idf over identifier tokens (split on `/`, `.`, `-`, `_`, and camelCase boundaries), acceptance-criteria text scored against file paths and identifiers. The vector tier of the wikis cascade is deliberately dropped — it needs embeddings, which would break "no install step".

**Input note:** `@octoshell/board`'s public `Task.acceptanceCriteria` is a **`string`** — a rendered `- [ ] text` checklist, not a structured array. There is no `AcceptanceCriterion[]` on the public type. Parse the checklist back into lines in `board.ts` and state that in a comment: it is deliberately format-agnostic across legacy `.md` and current YAML boards, which re-reading `task.yaml` directly would not be. Test the parse against both a checked and unchecked item and against an empty criteria block.

**The confidence threshold is measured, not invented.** Every other tunable in this package is a pinned constant with a stated rationale — `minSupport: 2`, `hubZThreshold: 3`, `halfLifeDays: 180`, A5b's `0.5` Jaccard bar. "No confident match" must get the same treatment, and this mission is unusually well placed to do it honestly: **Task 2's backfill produces a labelled dataset.** Every task with a resolvable `merged_sha` has a known true file set. So:

- [ ] **Step 1:** Failing test — a task whose criteria name a module scores that module's files above unrelated ones.
- [ ] **Step 2:** Failing test — determinism: same inputs, same ranking, ties broken by `compare`.
- [ ] **Step 3:** Calibrate against ground truth: run the predictor over every task that Task 2 attributed by `provenance`, compare against the true file set, and pick the score floor and runner-up margin from that measurement. **Report precision and recall at the chosen threshold** — including how many tasks the dataset holds, since a threshold fitted to a dozen samples is a weak prior and must be labelled as one, not presented as a tuned constant.
- [ ] **Step 4:** Pin the two numbers as named constants with the measurement in the comment, and expose them as config keys so a repo with different naming conventions can retune without a fork.
- [ ] **Step 5:** Failing test — a criterion of pure boilerplate ("the code is well tested") falls below the floor and produces **no** match rather than an arbitrary one. **A predictor with no signal must say so.**
- [ ] **Step 6:** Implement; green; commit.

**Acceptance criteria (board):** given a task whose criteria name identifiers present in one module, that module's files rank above files from unrelated modules; given identical inputs the ranking is byte-identical across runs; the confidence floor and runner-up margin are named constants whose values are justified by a reported measurement against provenance-attributed tasks, with precision, recall and sample size stated; given criteria with no distinctive identifiers the result is empty rather than an arbitrary top-N; the acceptance-criteria checklist string parses correctly for checked items, unchecked items and an empty block.

---

### Task 4: `own`

**Files:** Create `src/own.ts`, `test/own.test.ts`; modify `src/cli.ts`.

- [ ] **Step 1:** Failing test — `own <path>` names the owning mission and the criterion, each carrying its `mode`.
- [ ] **Step 2:** Failing test — `own` with no board exits with a clear error naming the missing board, not a stack trace.
- [ ] **Step 3:** Failing test — a repo whose worklog holds **only mission-level entries** (the day-one state of every adopting repo, and the state this repo was in on 2026-08-09) still answers, in `predicted` mode, labelled as such.
- [ ] **Step 4:** Implement; wire into `cli.ts`; green; commit.

**Acceptance criteria (board):** `own <path>` names the owning mission and the criterion the file exists to satisfy, and states the mode for each; `own` on a repo with no board fails with a message naming the missing board and a non-zero exit; on a worklog holding only mission-level entries `own` still answers and labels every answer `predicted`.

---

### Task 5: `conflicts`

**Files:** Create `src/conflicts.ts`, `test/conflicts.test.ts`; modify `src/cli.ts`.

Takes a mission or campaign, **not a pair**. Predicted mode only — it runs before code exists, so lexical matching is the sole mode permanently, not a degraded fallback.

**Interfaces produced:**

```ts
export interface ConflictPair {
  a: string; b: string;                 // task ids, `compare`-ordered
  shared: string[];                     // files BOTH tasks predict — the direct collision
  coupled: number;                      // summed nPMI over cross pairs of DISTINCT files
  modules: string[];                    // contended declared modules, `compare`-ordered
}
export function conflicts(analysis: Analysis, edges: Edge[], tasks: BoardTask[]): ConflictPair[];
```

> **The spec's "summed nPMI over predicted surfaces" does not cover the clearest conflict, and the
> score must not pretend otherwise.** `weighEdges` never emits a self-pair and `rollUp` drops
> self-loops, so two tasks predicting the *same file* have no edge between them and sum to **zero** —
> the most obvious sign of a bad split scoring lowest. So the result carries **two components,
> reported separately and never summed into one number**: `shared` (the intersection, listed by
> name) and `coupled` (summed nPMI over pairs of *distinct* files, one from each task). Blending
> them would produce a single figure meaning two different things at once — the same defect as the
> module row that said "21 files" while counting something narrower, and the edge weight that meant
> a count on one branch and a nPMI sum on the other. Rank by `shared.length` first, then `coupled`.
>
> `coupled` still earns its place: it is what catches two tasks that touch *different* files which
> history says always move together — the case raw overlap cannot see, and the reason the spec
> rejected raw overlap in the first place.

- [ ] **Step 1:** Failing test — two tasks predicting the same file are reported with that file in `shared`, and are ranked above a pair with none.
- [ ] **Step 2:** Failing test — two tasks predicting *different* files that historically co-change are reported with `coupled > 0` and `shared` empty.
- [ ] **Step 3:** Failing test — a file every task touches (a manifest) creates no conflict on its own: it is suppressed by the same noise floor `drift` uses, through `classifyPair`, not a second predicate.
- [ ] **Step 4:** Failing test — a clean decomposition reports nothing rather than the weakest available pair.
- [ ] **Step 5:** Failing test — a mission id, a campaign id, and an explicit task list are all accepted; the campaign path spans tasks from more than one mission.
- [ ] **Step 6:** Failing test — `conflicts` never reads the worklog, so it behaves identically on a mission-only worklog and on a fully-attributed one (mission criterion 3, for the half `own`'s tests do not cover).
- [ ] **Step 7:** Implement; wire into `cli.ts` — note `runCli` today accepts a positional only for `impact` and rejects them everywhere else, so both new commands need explicit positional handling; green; commit.

**Acceptance criteria (board):** given a mission id, `conflicts` reports pairs across all its tasks with contended modules named; two tasks predicting the same file report it in `shared` and rank above a pair with none; two tasks predicting distinct but historically co-changing files report `coupled > 0` with `shared` empty; `shared` and `coupled` are never combined into a single score; a manifest every task touches produces no conflict on its own; a clean decomposition reports none; mission id, campaign id and explicit task list are all accepted; results are identical against a mission-only worklog; every answer is labelled `predicted`.

---

### Task 6: End-to-end — no board, day-one board, and a mode that never lies

**Role:** `qa-engineer`

- [ ] **Step 1:** A repo with no `.octobots/` runs `map`/`impact`/`drift`/`doctor` normally and fails `own`/`conflicts` with a clear message and non-zero exit.
- [ ] **Step 2:** A fixture whose worklog holds only mission-level entries answers `own` in `predicted` mode — asserted on the rendered output, not in memory.
- [ ] **Step 3:** A fixture with a recorded `merged_sha` answers `provenance`; removing that SHA moves the same answer to `predicted`, and a SHA that does not resolve in the repo also yields `predicted` rather than an error. **The mode must change when the evidence changes** — and there is no third mode to fall into.
- [ ] **Step 4:** No output anywhere labels a lexical guess `provenance`.
- [ ] **Step 5:** The bundle still runs under bare `node` with no `node_modules`.
- [ ] **Step 6:** Every fixture repo removed on completion (`mkdtempClean`).

---

## Self-Review

**Spec coverage.** Mission criterion 1 (`own` names mission + criterion) → T4. Criterion 2 (mode never blurred) → T2, T4, T6S3–4. Criterion 3 (mission-only worklog) → T4S3, T6S2. Criterion 4 (`conflicts` takes a set) → T5.

**Open decision for the owner, surfaced not assumed:** if the `@octoshell/board` dependency grows the pack bundle unacceptably (measured in T1S4), `own`/`conflicts` become library-only rather than bundled CLI commands. That trade is the owner's call.

**Open risk:** `provenance` depends on a merge SHA being captured at the gate. A mission whose gate never runs — or a repo whose PRs `gh` cannot reach — gets `predicted` answers for that work, permanently. That degrades visibly, which is the point of the two labels, but it does mean coverage is a function of process discipline rather than of the tool.

**Reviewed by tech-lead 2026-08-10.** Four blocking findings, all folded in: leftover `inferred` prose contradicting the two-mode decision; the merge-SHA capture point (there is no merge-time write to add a field to — `work-log.mjs:74` fires only on `set-status.js`, and status is flipped before the merge); `conflicts` scoring, where summed nPMI structurally cannot express two tasks predicting the same file; and the lexical predictor's unstated confidence threshold. He also verified there is no `graph → board` cycle, that `@octoshell/board`'s public API is sufficient without deep imports, and estimated the bundle risk as comfortably inside the ~500 KB ceiling — unverified pending Task 1's actual measurement, since he was held to a read-only review while M7 was building.
