# octograph — the architecture map Octobots builds from your git history

`octograph` answers questions about a codebase that reading the code cannot answer, because it
mines a source no static tool looks at: **which files actually change together**.

It ships inside the Octobots extension. Two commands, no install step, no LLM, no server, no
network. A 202 KB self-contained bundle that runs under bare `node`.

---

## Why this exists

Two problems, both real, both expensive.

### 1. An agent landing in an unfamiliar repository

An agent starting work has to orient before its first useful edit — and its usual move is thirty
greps that consume the context window before any work begins. A token-budgeted module map, loaded
as session context, replaces that.

### 2. Coupling that no import edge explains

This is the one static analysis structurally cannot find. On this repository:

```
apps/…/octobots-pack/skill/mission-planner/scripts/entity-io.mjs
  <->  packages/board/src/entity-schema.ts
```

Two files implementing **one schema**, with **no import edge possible** — the pack script is
deliberately dependency-free, so it cannot import from `@octoshell/board` even in principle. There
is nothing for an AST to parse. Their divergence destroyed a campaign's decision record in July.

Git knew. They co-change, and `impact` surfaces the pairing that no import can explain.

The same evidence is stronger on repositories that do not squash-merge: on a sibling repo the
equivalent cross-service pair carries **support 9** — nine separate commits touching both.

That pair is `backend/agents/…/clients/conversations.py ↔ backend/conversations/…/api/internal.py`:
two services that must move together, in different packages, with no compile-time relationship
of any kind. `octograph` ranks it **first** of everything in that repository.

---

## Using it from the extension

### Install Graph

**Command Palette → `Octobots: Install Graph`**

Opens a terminal and runs `setup`, which:

1. runs `doctor` and tells you what it can and cannot see;
2. **asks before installing anything** — Graphify is optional and enriches `drift`; declining is a
   normal answer;
3. builds the first map;
4. prints the postflight.

The terminal is the interface. Nothing is captured, nothing is tracked, and the extension never
decides on your behalf.

### Rebuild Graph

**Command Palette → `Octobots: Rebuild Graph`**

Re-runs `map` after your history has moved on. Cheap — 0.07 s on this repository.

### The session primer

When `map.md` exists and fits the size cap, the Octobots session hook injects it as context, so a
CLI agent starts with the architecture already in hand. Over the cap, or absent, it emits a
one-line pointer instead — never a truncated map, because a truncated architecture map reads as
complete.

### How an agent should reach for it

The primer hands an agent the map. The **`knowledge-explorer`** skill — shipped in the Octobots
pack — is what tells it when to spend a query, how to read an empty result, and what to do with the
answer. Everything below is the instrument; that skill is the discipline for using it.

---

## What each command answers

| Command | The question |
|---|---|
| `map` | What is this codebase, in 2,000 tokens? |
| `impact <path>` | If I change this, what else moves? |
| `impact --diff [--staged\|--worktree] [--base <ref>]` | Given everything I've changed on this branch, what else should I check? |
| `drift` | What is coupled that nothing imports? |
| `own <path>` | Which mission owns this, and which acceptance criterion does it satisfy? |
| `conflicts <mission>` | Is this decomposition clean, or did I split one piece of work into three? |
| `doctor` | Why is my output thin, and what do I do about it? |

`own` and `conflicts` need an Octobots board; the rest work in any git repository.

### `impact --diff` — what does everything I've already changed touch?

`impact <path>` answers for one file. `impact --diff` unions that answer over every file the
current branch has changed — the question an executing agent actually has mid-task, since a
mission is a feature branch and the unit of work spans several commits plus whatever is not
committed yet.

```
changed: 3 file(s)

you may also need to change:
  packages/graph/test/cli.test.ts  npmi=0.612  support=4  via packages/graph/src/cli.ts
      known: architecture/dual-schema-entity-io.md — touch one, touch the other in the same PR

tests that historically move with this:
  packages/graph/test/conventions.test.ts  npmi=0.481  support=3  via packages/graph/src/diff-impact.ts
```

`--staged` and `--worktree` narrow the change set to the index or the uncommitted worktree only;
the default (`--diff` alone) is `merge-base(<ref>, HEAD)..HEAD` plus uncommitted work. `--base <ref>`
picks what the branch is measured against — `main` by default, or `Config.diffBase` in
`octograph.yaml`. `known:` lines are notes from the committed vault (`.agents/knowledge/` by
default) that explicitly *cite* the row's path — never a lexical guess, the same `cited`/`predicted`
distinction `own` makes.

`limit` means two different things on purpose: the inner `impact()` keeps its own per-path default
(20) so no single changed file can flood the union, and the same number caps each of the two
sections (`you may also need to change:` / `tests that historically move with this:`) again after
the merge. There is no `--limit` flag exposed for either — `octograph.yaml` and the CLI accept no
such key, so both stay at their defaults for every run.

`npmi`/`support` on a row describe only its STRONGEST source — the one changed file whose edge to
that row scored highest. Several changed files often pull the same row in (a shared test file, a
type both touch); rather than inline all of them beside a single edge's strength, the row names
that one explicitly (`strongest via <path>`) and counts the rest (`(+N more changed files)`). A row
pulled in by exactly one changed file has nothing to count, so it reads `via <path>` — the same
wording either way, this section's example above included. `impact --diff --json` serialises the
full `predictedBy` list for a caller that wants every source, not only the strongest.

An empty answer here is never printed bare: on thin or squash-merged history, the fine-grained
co-change `impact --diff` reads is exactly what a squash discards at merge time (see "Honest
limits" below), so "no rows" is rendered alongside `doctor`'s verdict — missing evidence, not
evidence of absence.

### `own` — tracing code back to intent

```
packages/graph/src/drift.ts
  owned by M3 - Drift, doctor and the shipped CLI / T3.1 - Noise floor and drift   (provenance)
  criterion (predicted): test paths are recognised across tests/, __tests__/, …
```

Every answer states **how it knows**:

- **`provenance`** — a merge SHA recorded on the board that still resolves in this repository. A fact.
- **`predicted`** — a lexical match against acceptance-criteria text. A guess, labelled as one.

The two are never blended. A lexical guess is never dressed as provenance.

---

## What it needs, and what it will tell you

Run `doctor` first. It grades every input and names a fix for each degradation. Alongside history
depth and Graphify, it also grades the committed knowledge vault as an optional third tier:
present, it lets `drift` say a coupling is already documented (`[known: <note>]`); absent, `drift`
still ranks the coupling but cannot make that call. Real output from this repository:

```
status: degraded

[ok]      repository: /Users/…/octoshell
[warn]    history depth: 28 analysable commits — co-change needs ~200 to be meaningful
          fix: nothing to unshallow — this repository squash-merges, so per-branch history was
               discarded at merge time; expect a sparse discovered graph and rely on the
               declared spine
[warn]    history shape: 30 of 40 commits look like squashed pull requests, and 3 exceeded
          max-commit-files and were dropped entirely
[ok]      graph composition: 160 files after exclusions; largest contributors apps 56%,
          packages 41%, (root files) 3%
[missing] graphify: not installed — drift can say "different modules" but not
          "nothing imports across them"
          fix: uv tool install graphifyy
[ok]      knowledge vault: 16 notes, 12 citing at least one path in the graph
```

Three states, three exit codes, so CI can gate on it: `ok` → 0, `degraded` → 1, `blocked` → 1.

> `uv tool install graphifyy` is **not** a typo. The repository is `Graphify-Labs/graphify`; the
> published package is `graphifyy`. A QA pass flagged it as one, which is why it is documented here.

---

## You do not have to configure it

Exclusions are set by default and cover this tool's own state, CI and editor config, committed
dependencies, python environments, and build output kept in tree. Measured on **six repositories
that were never used to design the list**, with no `octograph.yaml` at all:

| repository | removed by defaults | largest contributor, before → after |
|---|---|---|
| auqanautica | **61%** | `.octobots 43%` → **`edgeserver 74%`** |
| octowelth | 11% | `docs 43%` → `docs 49%` |
| pmi-manufacturing | 8% | `src 54%` → `src 59%` |
| wikis | 6% | `backend 69%` → `backend 74%` |
| sdlc-skills | 1% | `bundles 39%` (unchanged) |
| QloApps | 0% | `modules 50%` (unchanged) |

QloApps removing nothing is correct, not a miss: it commits no vendored dependencies, and
`modules/` at 50% genuinely *is* its architecture.

Most of that list is insurance. `harvest` reads `git log`, so an ordinary `node_modules` or `.venv`
is gitignored and never reaches the graph at all — across eight repositories, none appeared once.
They are listed for projects that *commit* them.

When something is still dominating your graph, `doctor` says so and hands you the config:

```
[warn] graph composition: 675 files after exclusions; largest contributors .octobots 43%,
       edgeserver 28%, .agents 16% — .octobots (43%), .agents (16%) look like tooling
       rather than architecture
  fix: if those are not part of your architecture, add them to octograph.yaml:
         excludePaths:
           - .octobots/
           - .agents/
       octograph does not decide this for you — a directory can legitimately dominate a graph.
```

It flags only what convention makes defensible — a dot-directory carrying real weight — and reports
the rest for you to judge. It will never decide that your `docs/` is not architecture.

Exclusions apply to the **whole graph** — the module map, clustering, working sets, `impact` and
`drift` alike — so what you exclude is simply not analysed. That is deliberate: on a repository
where the board was 43% of tracked files, including it doubled the co-change edges, took hub
quarantine from 5 files to 39, and mis-ranked 4 of the top 5 real module edges.

---

## Honest limits

**Squash-merging costs you the discovered half.** A squash collapses a branch into one commit, so
the fine-grained co-change this tool mines is discarded at merge time and cannot be recovered from
the repository. Measured here: a seven-mission campaign of 102 commits became one 147-file commit,
which then exceeded `max-commit-files` and was dropped entirely. `doctor` detects this and says so
rather than blaming your clone depth.

What squashing does **not** touch: the declared spine, its dependency edges, and `own`'s
provenance, which resolves through each task's recorded merge SHA.

**Thin history means thin output, and it says so rather than inventing structure.** Below the
`min-commits` threshold, working sets are suppressed entirely — absent, not caveated — because
community detection on sparse history invents structure from noise.

**Co-change is evidence of coupling, not evidence of a correct boundary.** `drift` and the working
sets report what they observed. They never recommend merging, splitting, or moving anything.

**Ranking is by evidence, not by correlation strength.** nPMI saturates near 1.0 for any pair that
always co-occurs — trivially true of a pair seen exactly twice — so scores are shrunk by support.
Before that fix, the cross-service pair this tool exists to find ranked 18th of 20, beneath seven
rows seen twice each.

---

## Configuration

`octograph.yaml` at the repository root. Every key is optional and every one carries its reasoning
in the file itself. Commit it, so a local run and a CI run cannot disagree and churn the artifact.

Artifacts land in `.octobots/graph/` when you have a board, `.octograph/` otherwise. If that
directory is gitignored, `doctor` will point out that cluster ids reset on every fresh clone — a
recommendation, never a requirement.

Two more keys, both optional: `vaultPath` (default `.agents/knowledge`) points `doctor` and
`drift`'s `[known: <note>]` marking at the committed knowledge vault, for a repository that keeps
it somewhere else. `diffBase` (default `main`) is the ref `impact --diff` measures the current
branch against, for a repository whose trunk has another name — set it once here rather than
passing `--base` on every run.
