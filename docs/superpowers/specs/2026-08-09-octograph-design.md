# Octograph — Design

**Date:** 2026-08-09
**Status:** Draft (design)
**Components:** new repo `arozumenko/octograph`; bridge in `apps/vscode-extension` (host + pack)

---

## Problem

An agent landing in an unfamiliar repo has to reconstruct its architecture by grepping. That is
slow, token-expensive, and it only ever recovers what the source text *states*.

Two categories of coupling are invisible to any source-text analysis:

1. **Mirrored implementations.** In this very repo, `packages/board/src/entity-schema.ts` and
   `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs`
   implement the same on-disk schema twice. They share **no import edge and never can** — the
   pack script is deliberately dependency-free. The coupling exists only as a comment. Breaking
   the pair destroyed a campaign's decision record on 2026-07-27.
   Git says: 4 commits touch one, 3 touch the other, **3 touch both** — confidence 1.0.
2. **Intent.** Which mission owns a module; which acceptance criterion a file exists to satisfy;
   which external ticket it traces to. Nothing in the source records this.

Meanwhile the Octobots board is **transient**: a task exists to be executed and is then dead
weight, because nothing reads it after its PR merges. It has no read path after completion.

Octograph addresses both: it reconstructs the **actual** architecture from commit history, and it
makes the board durable by joining work items to the code they produced.

---

## Non-goals

These are load-bearing. Each one is a tarpit we are explicitly declining to enter.

- **Not a code search tool.** Localization ("where is `parseCriteria` defined") is grep's job and
  grep wins. Competing there is how this becomes a parser project.
- **Never parses source.** No tree-sitter, no AST, no LSP, no language grammars — ever. That is
  Graphify's job and they do it across 36 languages with YC funding behind them.
- **No LLM, no embeddings, no vector store.** Every output is deterministic and reproducible.
- **No server, no daemon, no database.** A CLI that reads git and writes files.
- **Not a Graphify fork or extension.** Zero shared code. We read one narrow slice of its output
  if it happens to exist.

---

## Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| D1 | Depend on `wikis`? | **No** | Docker + FastAPI + FAISS + LLM key inverts Octobots' zero-server identity. Port the algorithms instead. |
| D2 | Anchor on work items or modules? | **Modules** | Work-item anchoring has a fatal cold start: an existing repo has no board history, so the graph is empty exactly when it is most needed. Modules give day-1 value; the board attaches to a spine that already stands. |
| D3 | Declared or discovered structure? | **Declared spine + discovered delta** | The declared side is trustworthy; the discovered side reveals reality. **The delta between them is the artifact nobody else produces.** |
| D4 | Depend on Graphify? | **Optional file read** | Present → tree-sitter-precise import edges for free. Absent → fall back to manifests + directories. Never required. |
| D5 | Where does it live? | **Separate repo, bridged** | Mirrors the `sdlc-skills` precedent: Octobots is a thin launcher, the library owns the truth. |
| D6 | Library scope | **Standalone; board is an overlay** | Must run usefully in a repo with no `.octobots/`. This is an *architectural* constraint, not a release phase. |
| D7 | Output location | **`.octobots/graph/` when a board exists**, neutral dir otherwise | Settled by precedent: `.octobots/` already holds five non-entity subdirectories (`tokenomics/`, `hooks/`, `teams/`, `pastes/`, `.trash/`). `board-model.ts:89` skips directories lacking a `<kind>.yaml`, so artifacts there are invisible to the parser. Never *creates* `.octobots/`. |
| D8 | Release shape | **v1 and v2 planned together** | Early adopters are Octobots users; they all have boards. Shipping the standalone half alone would test the least-used surface first. |
| D9 | Language | **Node, zero runtime deps** | Matches `npx github:` bridging, matches the pack's vendored `.mjs` convention, needs no venv or `uv`. |
| D10 | Detect installed state? | **Yes — `doctor`**, deviating from sdlc-skills' Q4 "pure stateless launcher" | sdlc-skills installs files; success or failure is visible in the terminal. Octograph's failure mode is **silent degradation** — absent Graphify just makes `drift` blunter, thin history just makes the map sparse. Nothing announces itself, and a user cannot trace "this map looks useless" back to its cause. Detection is warranted exactly where failure is quiet. |
| D11 | Where do health checks live? | **In octograph (`doctor`), not the extension** | Keeps the launcher thin per D5, and CLI users get identical diagnostics. The extension runs `doctor` and shows the terminal; it never re-implements the checks. |

---

## Architecture

```
                    ┌─ git log --name-only ──► co-change graph      REQUIRED
                    │                          (decay → nPMI → hub
                    │                           quarantine → Louvain)
 octograph (node) ──┤
                    ├─ declared spine ───────► precedence chain:     OPTIONAL
                    │                           1. graphify-out/graph.json
                    │                           2. manifests + directories
                    │
                    └─ .octobots/ ───────────► board overlay          OPTIONAL
                                                worklog.jsonl +
                                                branches → task↔file
                                                          ↓
                                          .octobots/graph/map.md
                                          .octobots/graph/graph.json
```

Three inputs, one required. Each is a file read; none is a process dependency.

### Input 1 — git history (required)

`git log --name-only --no-merges --pretty=format:...` parsed in Node. This is the entire
substrate. No other required input exists.

### Input 2 — declared spine (optional, precedence chain)

| Priority | Source | Gives |
|---|---|---|
| 1 | `graphify-out/graph.json` | Real import/call edges from tree-sitter across ~36 languages |
| 2 | Workspace manifests | Authoritative module boundaries: `pnpm-workspace.yaml`, `package.json` workspaces, `go.mod`, `Cargo.toml`, `pyproject.toml`, `*.csproj` |
| 3 | Directory structure | Always available. Weakest, never absent. |

**Read surface from Graphify is deliberately minimal:** file→file and module→module import edges
only. We ignore its symbols, communities, rationale nodes, and confidence tags. A four-month-old
project with 861 open issues will churn its schema; a narrow surface means a schema change breaks
one adapter function rather than the tool.

### Input 3 — board overlay (optional)

`.octobots/tokenomics/worklog.jsonl` records `session_id → task → branch`. Git maps
`branch → commits → files`. Joining them yields **task ↔ file** provenance as a fact rather than
an inference from branch-name convention.

---

## Algorithms

Each choice below is a decision, not a default. Rationale included because the wrong choice here
produces a graph that looks plausible and is useless.

### A1 — Harvest and mega-commit filtering

Commits touching more than `--max-commit-files` (default **50**) are dropped. A 500-file commit is
a rename sweep, a formatter run, or a vendored-dependency bump; it asserts that every touched file
couples to every other, which is false and swamps the signal. This filter matters more than its
size suggests.

### A2 — Recency decay

Pair weight `w(a,b) = Σ_commits e^(−λ · age_days)`, default **half-life 180 days**
(`λ = ln2/180`).

Coupling from last month should outrank coupling from two years ago. This is a capability the
AST-based tools structurally lack — they see one snapshot.

### A3 — Normalized PMI, not raw counts

`nPMI(a,b) = PMI(a,b) / −log P(a,b)`, where `PMI = log( P(a,b) / (P(a)·P(b)) )`.

**Deliberate deviation from `wikis/graph_topology.py`.** wikis applies inverse in-degree weighting
(`1/log(indeg+2)`) — a hand-tuned correction for AST hub-ness. In co-change data hub-ness *is* a
frequency property (`pnpm-lock.yaml` co-changes with everything), and nPMI suppresses it as a
property of the math rather than a patch layered on top. Normalization bounds the result to
`[−1, 1]`, which makes thresholding meaningful across repos of different sizes.

Pairs with fewer than `--min-support` (default **2**) co-occurrences are dropped as noise.

### A4 — Hub quarantine

Nodes whose **weighted degree (strength)** has a Z-score > **3.0** are flagged and excluded from
clustering, then reattached by plurality vote to their most-connected community.

Adapted, not ported, from `wikis/graph_topology.py`: wikis measures **in-degree** because its AST
graph is directed. The co-change graph is **undirected** — co-occurrence has no direction — so
in-degree is undefined here and strength is the correct analogue.

nPMI already suppresses hub *weight*; quarantine is still required because hubs *bridge* unrelated
communities and distort partitioning even at low weight.

### A4b — Layer ranks (declared spine only)

Layer ranks come from a topological ranking of the **directed** module dependency graph: modules
with no inbound dependencies are entry points, modules with no outbound ones are leaves. This is
the analogue of `wikis`' `layer` field (`core_type`, `public_api`).

**This requires the declared spine**, since co-change edges carry no direction. With Graphify
present the ranking is precise; with only manifests and directories it is coarse; with neither,
`map` omits layer ranks rather than guessing. Cycles are contracted to a single rank and reported
— a dependency cycle between modules is itself a finding worth surfacing.

### A5 — Louvain community detection

Louvain over the weighted undirected co-change graph. Communities are the **discovered** modules.

Resolution auto-tuned by node count, port of `wikis/graph_clustering.py:auto_resolution`:

```
γ = max(0.3, 1.0 − 0.2 · log₁₀(node_count))     # γ = 1.0 when node_count < 2
```

Lower γ yields fewer, larger communities. The formula is tuned so typical repos land in a sane
range before any consolidation step.

Vendored or hand-rolled (~200 lines) — same pattern as the pack's `vendor/js-yaml.mjs`. No runtime
dependency. **Fixed seed**, so a given graph always produces the same partition.

### A5b — Cluster ID stability (Jaccard remap)

**Without this, the committed artifact is worthless.** Louvain is deterministic given a fixed seed
and an unchanged graph, but the *IDs* it assigns are arbitrary — insertion order of the partition.
The same logical module can come back labeled 7 instead of 3, which would rewrite most of `map.md`
on a run where nothing architectural changed. That destroys the entire "architecture drift appears
in code review" premise, since every diff would be noise.

Port of `wikis/cluster_stability.py`:

> For each new cluster N, compute `Jaccard(N.nodes, O.nodes)` against every old cluster O. If the
> best similarity ≥ **0.5**, N inherits O's ID. Otherwise N gets a fresh ID counting up from
> `max(old_ids) + 1`.

The 0.5 threshold requires more than half the union preserved — below it unrelated clusters get
matched, above it minor membership churn breaks IDs.

The elegant part: **the previous run's clusters come from the committed `graph.json` itself.** The
artifact being in git is what makes its own stability computable. No state store needed.

### A5c — Module rollup (projection)

File-level co-change is too fine for `map.md`. Roll files up to modules by the same mechanism as
`wikis/graph_clustering.py:architectural_projection`: remap each edge endpoint to its parent
module, **drop edges that become self-loops** (intra-module churn is not a signal), and **sum
weights** across collapsed edges.

Module identity comes from the declared spine when present, from discovered communities when not.

### A5d — Naming discovered modules

A Louvain community is a set of files with no name. Label it by its most central members:
**PageRank over the undirected projection of the community subgraph, top-k (default 5)**, port of
`wikis/graph_clustering.py:select_central_symbols`.

Undirected specifically so that hub-like files (touched by everything) and authority-like files
(everything touches them) rank comparably rather than one drowning the other.

### A5e — Component bridging

Co-change graphs are routinely disconnected — files touched in a single commit, or never touched
alongside anything, form isolated islands. This matters because **Louvain emits at least one
community per connected component regardless of resolution**, so an unbridged graph produces a
long tail of junk single-file "modules".

Port of `wikis/graph_topology.py:bridge_disconnected_components`: sort components largest-first,
and for each non-largest component attach a lightweight bridge edge to the most
directory-similar larger component (min-intersection of directory histograms), linking their
highest-degree representatives. Bridge edges are tagged synthetic and weight-floored so they
connect without distorting.

### A6 — Drift diff

The differentiated output. Two directions:

- **Hidden coupling** — pairs with high nPMI and *no* declared edge between them. The
  `entity-schema.ts` ↔ `entity-io.mjs` case.
- **Erosion** — declared boundaries that co-change routinely violates. Two workspace packages that
  always change together are one package wearing a costume.

Assertion strength depends on the spine: with Graphify, "nothing imports across them" is a real
claim. Without it, the claim weakens to "they sit in different declared modules." `drift` degrades
in precision, not in availability.

### A7 — Board overlay

- **Provenance** — task ↔ file from worklog + git. Rolled up to **mission ↔ module** ownership,
  which is stabler than task↔file because modules persist while files churn.
- **Cold start** — a task that has never run has no commits. Attach it by lexical match of its
  acceptance-criteria text against file paths and identifiers (tf-idf over identifier tokens).
  This is the non-vector tier of `wikis`' three-tier orphan cascade; the vector tier is dropped
  because it would require embeddings.
- **Conflict prediction** — score two tasks' predicted file sets by summed nPMI rather than raw
  overlap. Raw overlap is useless: every task touches `package.json`. This is what could let
  `workflow-designer` prove two tasks are disjoint and fan them out, replacing the current
  one-branch-at-a-time rule with evidence.

### A8 — Test files: tag, never drop

Tests co-change with their subject constantly. The naive reactions — treat that as the strongest
signal, or discard tests as noise — are both wrong.

Policy ported from `wikis/docs/proposals/test-exclusion-and-filtering`: **tag `is_test`, exclude
from clustering only.** Tests stay in the graph, stay queryable, stay in `impact` output. They are
skipped when computing communities so they neither form bogus test-shaped modules nor drag module
boundaries toward the test tree.

This preserves the single most useful edge in the graph — **test ↔ subject**, which is exactly the
"which tests must run for this change" answer `mission-completion-gate` needs — while keeping the
architecture map about architecture.

Detection is path-based: a set of independently-compiled regexes over directory names and file
suffixes (`wikis/cluster_constants.py:_TEST_PATH_PATTERNS` ships 17). Deterministic and
language-agnostic; no parsing.

### A9 — Token budgeting

`map.md` targets a stated budget (default ~2k tokens). Since octograph has no runtime
dependencies, there is no tokenizer available — use **`chars / 4` estimation**, which is the same
fallback `wikis/token_counter.py` uses when tiktoken is absent.

Estimation is honest here rather than a compromise: the budget governs *how many modules and edges
to render*, and that decision is not sensitive to a ±15% token estimate. Rendering is truncated by
descending PageRank so the most central modules survive the cut.

---

## Output contract

Narrow on purpose. The compression *is* the product; a wide surface dilutes it.

| Command | Board required | Output |
|---|---|---|
| `map` | no | Module architecture: modules, dependency edges, hub markers, and layer ranks *when a declared spine is available* (A4b). Token-budgeted, default target **~2k tokens**. |
| `impact <path>` | no | Blast radius: coupled files and modules ranked by nPMI, plus declared dependents. |
| `drift` | no | Hidden coupling and boundary erosion (A6). |
| `own [<path>]` | **yes** | Which mission owns this module; which criterion this file exists to satisfy; linked external ticket. |
| `conflicts <taskA> <taskB>` | **yes** | Collision score and the specific contended files. |
| `doctor` | no | Preflight and postflight diagnostics (see below). Exit non-zero when a **required** input is missing; exit zero with warnings when an optional one is. |

Global flags: `--out`, `--since`, `--max-commit-files`, `--half-life`, `--min-support`,
`--budget`, `--json`.

### `doctor` — the silent-degradation guard

Every input is graded, and each degraded one states **what it costs and how to fix it**. A "✓ done"
that hides a useless result is the outcome this command exists to prevent.

```
octograph doctor

  Required
  ✓ git                  2.43.0
  ✓ repository           /Users/…/octoshell
  ⚠ history depth        4 commits — co-change needs ~200+ to be meaningful
                         shallow clone, or a squashed migration?
                         → map/impact will be sparse; drift unreliable

  Declared spine  (precedence: graphify → manifests → directories)
  ✗ graphify             not installed     → uv tool install graphifyy
  ✓ manifests            pnpm-workspace.yaml, 3 × package.json
  ✓ directories          always available
    → using manifests. drift can say "different modules" but not
      "nothing imports across them"

  Board overlay
  ✓ .octobots/           found
  ✓ worklog.jsonl        142 entries
  ✓ tasks with criteria  31

  Artifacts
  ✗ .octobots/graph/     not built         → octograph map
```

**Postflight** (printed after every `map` run) reports signal quality, not just success:

```
built 14 modules from 1,247 commits / 203 files
spine: manifests (graphify absent)   median pair support: 6   hubs quarantined: 3
bridged 4 disconnected components    cluster IDs: 12 kept, 2 new
```

`cluster IDs: kept / new` is the line that matters most in day-to-day use — a run reporting many
new IDs against an unchanged codebase means A5b regressed, and the committed artifact is about to
churn.

**Machine-readable:** `doctor --json` for CI, so a pipeline can fail on a degraded graph.

---

## Artifacts

| Path | Content |
|---|---|
| `<out>/map.md` | Human- and agent-readable architecture map |
| `<out>/graph.json` | Machine-readable full graph |

`<out>` resolves to `.octobots/graph/` when `.octobots/` exists, else `.octograph/`.

**Committed to git, deliberately.** The consequences are the point:

- **Architecture drift appears in code review.** A PR that introduces coupling across a module
  boundary produces a visible diff line. Same trick as the board itself — make the invisible thing
  a file, and git supplies history, review, and blame for free.
- **A committed derived artifact is a lockfile, not a cache.** The staleness objection is answered
  the way lockfiles answer it: CI regenerates and fails on drift, in about ten lines.

Diff noise is controlled by stable sort order and module-level (not file-level) granularity in
`map.md`.

**Boundary that must not be crossed:** octograph never writes entity YAML and never requires the
board to run. Derived artifacts in their own subdirectory sidestep the `entity-schema.ts` /
`entity-io.mjs` dual-schema hazard entirely, because nothing round-trips through the pack scripts.

---

## Octobots bridge

Inherits the principle established for sdlc-skills in
`docs/superpowers/specs/2026-07-23-sdlc-bundle-install-command-design.md`:

> **Octobots is a thin launcher; the library owns the truth.**

### `octograph setup` — the interactive installer

D10 wants installed-state detection; D5 wants a launcher that never captures output. Both hold if
the interactivity lives in the library, exactly as sdlc-skills does it:

`setup` runs `doctor`, then for each missing-but-installable input **prompts** and runs the install
itself, then builds and prints the postflight. The extension only opens a terminal on it.

Safety rules:

- **Prompt before installing anything.** Never install as a side effect of a build.
- **Never pipe a remote script to a shell.** Graphify installs via `uv tool install graphifyy`;
  if `uv` itself is absent, print its install URL and stop. Convenience does not justify
  `curl … | sh` on the user's machine.
- **Never install into the repo.** Graphify is a user-level tool; `setup` touches no tracked file
  except the artifacts under `<out>/`.

### Extension commands

- `src/host/octograph.ts` — command-string construction and artifact-path resolution. Pure
  functions, unit-tested. Mirrors `sdlc-bundles.ts`, including validating any interpolated argument
  against a safe-slug pattern before it reaches a terminal.
- `src/host/octograph-command.ts` — thin VS Code glue registering two commands:
  - **"Octobots: Install Graph"** → `npx github:arozumenko/octograph setup` — first-run flow:
    health checks, prompted installs, initial build.
  - **"Octobots: Rebuild Graph"** → `npx github:arozumenko/octograph map` — the routine path.

  Both create a terminal, send the command, and show it. **No output capture, no state tracking, no
  post-run verification** — the terminal is the interface, and `doctor` is the only thing that
  knows how to judge the result.
- `hooks/primer.mjs` — injects `.octobots/graph/map.md` as session context **when it exists and is
  under a size cap**; otherwise injects a one-line pointer to the command. Agents do not call tools
  they forget exist, so ambient orientation is what actually gets used.

Explicitly deferred, additive once artifacts land: an MCP server, and an extension-side map view.
Artifacts under `.octobots/` are already inside `board-watcher`'s scope, so the view needs no new
plumbing.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Graphify churns its schema | Medium | Narrow read surface (import edges only) confined to one adapter |
| Graphify adds history mining | Medium | Co-change is the differentiated hook, **not the moat**. The moat is the board join, which they cannot grow. Design degrades to the overlay rather than dying. |
| **Short or rewritten history** | **High** | Squashed migrations and fresh repos destroy the signal — *this repo was migrated as a single history-less commit*. **`doctor` grades history depth and says so** rather than emitting confident nonsense; degraded runs lean on the declared spine and label themselves as such. |
| Cross-repo coupling invisible | Medium | Inherent to git-history analysis in a polyrepo. State as a documented limitation; do not paper over it. |
| Generated files and lockfiles dominate | Low | nPMI suppresses them mathematically; plus an explicit ignore list |
| Committed artifact churns on every run | Low | **A5b (Jaccard cluster-ID remap) is the real mitigation** — without it this risk is critical, since arbitrary Louvain relabeling would rewrite `map.md` on architecturally-unchanged runs. Plus stable sort and coarse granularity. Graphify solves the merge half with a git merge driver — adopt if it bites. |

---

## Testing

Vitest, matching the monorepo convention.

- **Fixture repositories** — temp git repos built by script with known commit histories, so
  co-change, decay, and PMI assertions are exact rather than approximate.
- **Algorithm units** — decay, nPMI, hub Z-scores, and Louvain tested against hand-computed values.
- **Golden files** — `map.md` rendering, to catch unintended diff churn in the committed artifact.
- **Stability (A5b)** — build a fixture repo, run, append commits that change one module, re-run.
  Assert unchanged modules keep their cluster IDs and that `map.md`'s diff is confined to the
  module that actually changed. This is the test that protects the product's central claim.
- **Degradation paths** — every optional input absent: no Graphify, no board, no manifests,
  near-empty history. Each must produce useful output or an honest refusal, never a confident
  wrong answer.
- **Bridge** — pure functions in `octograph.ts` unit-tested host-side, per the sdlc-bundles
  precedent.

---

## Success criteria

1. `map` on a cold checkout of this repo completes in under 2 seconds with no Graphify present.
2. `drift` surfaces the `entity-schema.ts` ↔ `entity-io.mjs` pair, which no AST tool can find.
3. Every command produces useful output with **no** `.octobots/` directory present.
4. `map.md` fits a stated token budget and is regenerable byte-identically from the same commit.
5. The Octobots bridge adds no runtime dependency to the extension.
6. `doctor` correctly grades this repo as **degraded** (thin history, no Graphify) and names both
   causes with their fixes — the failure this design is most likely to ship silently.

---

## Provenance — what comes from `wikis`

`wikis` (MIT, same author) is the reference implementation for most of the topology and clustering
math here. Octograph ports the *ideas* to a different substrate — co-change instead of AST — in
Node instead of Python, without networkx, igraph, leidenalg, numpy, or tiktoken.

| Octograph | Source in `wikis` | Adaptation |
|---|---|---|
| A4 hub quarantine | `graph_topology.py:detect_hubs` | **in-degree → weighted degree** (co-change is undirected) |
| A5 auto-resolution | `graph_clustering.py:auto_resolution` | verbatim formula |
| A5b cluster stability | `cluster_stability.py` | verbatim algorithm; old clusters read from the committed artifact instead of a DB |
| A5c module rollup | `graph_clustering.py:architectural_projection` | symbol→parent becomes file→module |
| A5d module naming | `graph_clustering.py:select_central_symbols` | verbatim (PageRank, undirected, top-k) |
| A5e component bridging | `graph_topology.py:bridge_disconnected_components` | verbatim (directory-histogram similarity) |
| A7 cold-start lexical | `graph_topology.py:resolve_orphans` | **lexical + directory tiers only**; vector-KNN tier dropped (no embeddings) |
| A8 test policy | `docs/proposals/test-exclusion-and-filtering` | verbatim policy: tag, exclude from clustering only |
| A9 token estimation | `token_counter.py` | the `chars/4` fallback path becomes the only path |

Deliberately **not** taken: FTS5/vector indexing, the JQL query language, the expansion engine,
`ChangeDetector`'s four-regime router (git is the change detector), and everything LLM-facing.

---

## Follow-ups (not in this design)

- Record this work on the Octobots board as a campaign with missions, via `mission-planner`.
- MCP server exposing `map` / `impact` / `drift` as tools.
- Extension-side map view rendering `.octobots/graph/graph.json`.
- External-tracker link field (`links:` on board entities) — needs modeling in **both**
  `packages/board/src/entity-schema.ts` and the pack's `entity-io.mjs`, per the dual-schema rule.
