# octograph: diff-scoped impact, and the knowledge vault as an evidence tier

**Date:** 2026-08-13
**Status:** approved design, not yet planned
**Packages touched:** `packages/graph`, `apps/vscode-extension` (pack payload + version cohort)

---

## Why

Two gaps, found by comparing octograph against two neighbouring tools —
[Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (tree-sitter + LLM,
onboarding-oriented) and [Graphify](https://github.com/Graphify-Labs/graphify) (tree-sitter, no LLM,
agent-query-oriented, already consumed by `graphify.ts` as octograph's declared-dependency tier).

Most of what those tools do does not transfer. Their semantic layers — plain-English node summaries,
LLM-assigned architectural layers, business-domain maps — cost tokens and are non-deterministic,
which negates the property that lets octograph run on every session start in 0.07 s: *no LLM, no
server, no network* (`docs/octograph.md`). Octograph also already has better answers for two of
them: `layers.ts` computes layers structurally, and `own` maps code to mission and acceptance
criterion with a `provenance` / `predicted` label that no LLM domain-guess can offer.

Two things do transfer, and one thing neither tool has emerges from combining them with this repo's
own knowledge vault.

1. **Diff-scoped impact.** Understand-Anything's `/understand-diff` is its most agent-useful
   command. Octograph has no equivalent: `impact` takes exactly one path
   (`cli.ts` — `"impact requires exactly one <path> argument"`). The question an executing agent
   actually has is *"I changed these files — what does history say usually moves with them, and
   which tests cover them?"*

2. **Saying what a module is for.** Understand-Anything's per-node summaries are its core value.
   Octograph can produce the same effect without an LLM, because the text already exists on the
   board (`own`) and in the vault (`.agents/knowledge/`).

3. **The vault as a first-class evidence tier.** The `knowledge-explorer` skill (pack v51) declares
   a hierarchy octograph itself does not participate in:

   ```
   .agents/knowledge/    the committed, verified vault     OBLIGATORY
   octograph             the co-change graph from git      OPTIONAL
   ```

   That skill also states the loop this design mechanises: *"the graph is how the vault grows."*
   Today that is an exhortation to the agent. It becomes a mechanism.

The premise is already validated by the repo's own history: `.agents/knowledge/architecture/
pack-version-is-one-unit.md` was discovered by running `octograph impact` on a pack file and finding
a six-file cohort with 19 commits of support that shares no token with its trigger. That is exactly
the shape `impact --diff` is meant to surface automatically.

---

## Design principles inherited from the package

These are not new. They are the rules this design must not break.

- **Every answer states how it knows.** `own` labels `provenance` (a merge SHA that still resolves)
  against `predicted` (a lexical guess) and never blends them. `map.md` renders `→` only when a
  declared spine backs the direction, `↔` otherwise (`render.ts`). Any new evidence gets the same
  treatment.
- **Missing evidence is never rendered as evidence of absence.** `doctor` grades every input and
  names a fix per degradation. An empty result under thin history means *"we cannot see"*, not
  *"there is nothing"*.
- **Optional inputs degrade, they do not break.** `readGraphify` never throws on an absent or
  malformed `graph.json` (`graphify.ts`). The vault reader follows that contract exactly.
- **No install step, no network, no LLM, no embeddings.** `lexical.ts` documents dropping the vector
  tier on purpose for this reason.
- **Nothing in this package parses source.** "Identifiers" means path segments, never exported
  symbol names (`lexical.ts`). The vault reader parses *markdown frontmatter and prose*, which is
  not source, and must not become a back door to source parsing.

---

## Architecture

Three units, each independently testable.

```
                        ┌──────────────────┐
   .agents/knowledge/ ──►   vault.ts       │  NEW  — read + match notes to paths
                        └────────┬─────────┘
                                 │ VaultMatch[]
   git range ──────────► diff-impact.ts ───┤  NEW  — changed set → ranked co-change rows
                                 │
   Analysis ────────────►    render.ts     │  EDIT — module purpose lines
                        └──────────────────┘
                                 │
   Analysis ────────────►    drift.ts      │  EDIT — [known: <note>] marking
```

### Unit 1 — `src/vault.ts` (new)

**What it does.** Reads `.agents/knowledge/**/*.md` and answers one question: *which notes are about
this path?*

**Interface.**

```ts
export interface VaultNote {
  /** Repo-relative path of the note itself, e.g. "architecture/dual-schema-entity-io.md". */
  note: string;
  /** Frontmatter `name`, or the filename stem when absent. */
  name: string;
  /** Frontmatter `description`, flattened to one line. */
  description: string;
  /** Frontmatter `verified` or `created`, ISO date, or null. */
  verified: string | null;
  /** Repo-relative paths the note's body explicitly names. */
  cites: string[];
}

export type VaultMode = "cited" | "predicted";

export interface VaultMatch {
  path: string;          // the source path being asked about
  note: string;          // VaultNote.note
  description: string;
  mode: VaultMode;
  confidence: number;    // 1 for cited; the tf-idf score for predicted
}

export function readVault(repoRoot: string): VaultNote[];
export function matchVault(
  notes: readonly VaultNote[],
  paths: readonly string[],
  lexical?: LexicalOptions,
): VaultMatch[];
```

**Two modes, never blended** — the `own` precedent, applied to a new source:

- **`cited`** — the note's body contains a string that resolves to a real repo-relative path.
  `architecture/dual-schema-entity-io.md` names both `entity-io.mjs` and `entity-schema.ts`. This is
  a fact about the note, verifiable without judgement.
- **`predicted`** — tf-idf over the note's `name` + `description` + `aliases` + `tags` against the
  path's identifier-shaped tokens, through the existing `tokenize()` and `STOPWORDS` from
  `lexical.ts`. A guess, labelled as one, subject to `lexicalConfidenceFloor`.

**Calibration hazard, stated explicitly.** `lexical.ts`'s `STOPWORDS` doc comment and
`practices/knowledge-vault-sentence-filenames-confound-lexical-matching.md` record that this repo's
sentence-shaped note filenames out-scored real source files for 5 of 8 provenance-attributed tasks
when scored without stopword filtering. That finding is about the *criteria → file* direction. This
design runs the *path → note* direction, where notes are the corpus and a path is the query. The
confound does not automatically transfer and does not automatically vanish: the predicted tier must
be calibrated against this repo's real vault before it ships, using the same method the original
note used (score against the 8 provenance-attributed tasks, inspect the top-ranked candidate). If
calibration cannot produce a defensible floor, **ship `cited` only** — a tier that fires rarely and
correctly beats one that fires often and plausibly.

**Never throws.** Absent `.agents/knowledge/`, unreadable file, malformed or absent frontmatter, or
a body citing a path that no longer exists — each degrades to fewer matches, never to an exception.
Same contract, same reasoning as `readGraphify`.

**Path extraction for `cites`.** Scan the note body for path-shaped tokens (containing `/`, ending
in a known source extension, or matching a tracked path prefix), then keep only those that resolve
against the candidate corpus `harvest` already produces. A path named in prose that does not exist
in the repo is dropped silently — it is stale documentation, not a citation. `repoRelative()` from
`paths.ts` normalises, and anything escaping the root is dropped, exactly as `graphify.ts` does with
foreign node paths.

**Doctor check.** A fifth graded input, alongside graphify:

```
[ok]      knowledge vault: 24 notes, 19 citing at least one tracked path
[missing] knowledge vault: .agents/knowledge not present — drift can rank a coupling
          but cannot say whether it is already documented
          fix: create .agents/knowledge/ per AGENTS.md § Agent memory
```

Note: the repo-gap paragraph in `.agents/knowledge/README.md` ("found 2026-08-09 … nothing in here
is actually tracked by git yet") is **stale** — `.gitignore` now reads `.agents/*` with
`!.agents/knowledge/` and 24 files are tracked. Correcting that note is out of scope here but should
be filed; a stale note in a layer whose charter is "correct or delete the moment it stops being
true" is exactly the failure that charter names.

### Unit 2 — `src/diff-impact.ts` (new)

**What it does.** Turns a git range into a ranked answer.

**Interface.**

```ts
export type DiffScope =
  | { kind: "branch" }              // merge-base(<base>, HEAD)..HEAD + uncommitted  (default)
  | { kind: "staged" }
  | { kind: "worktree" }
  | { kind: "since"; rev: string };

export interface DiffImpactRow extends ImpactRow {
  /** Which of the changed paths pulled this row in, strongest first. */
  predictedBy: string[];
  /** Vault notes about this row, `cited` before `predicted`. */
  notes: VaultMatch[];
}

export interface DiffImpactAnswer {
  changed: string[];
  source: DiffImpactRow[];
  tests: DiffImpactRow[];
}

export function changedPaths(repoRoot: string, scope: DiffScope, base: string): string[];
export function diffImpact(
  changed: readonly string[],
  edges: Edge[],
  files: string[],
  notes: readonly VaultNote[],
  limit?: number,
  minSupport?: number,
): DiffImpactAnswer;
```

**Algorithm.**

1. Resolve the changed set. Default `branch` scope: `git merge-base <base> HEAD`, then
   `git diff --name-only <mergeBase>..HEAD`, unioned with `git status --porcelain` for uncommitted
   work. `base` defaults to `main`, configurable. Read with `-z` and the same
   defensive record handling `harvest.ts` already applies — a path may legally contain a newline.
2. Apply `isExcludedPath` with the configured `excludePaths`, so the diff obeys the same exclusions
   as the rest of the graph. A change to an excluded path contributes nothing, matching the
   documented rule that exclusions apply to the whole graph.
3. For each remaining changed path, call the existing `impact()` unchanged. `limit` is applied
   **twice and means two different things**: `impact()` keeps its own per-path default (20) so no
   single changed file can flood the union, and `diffImpact`'s `limit` caps each of `source` and
   `tests` after the merge. Both are stated in `--help`; an unqualified "limit" on a command that
   fans out over N paths is the kind of number a reader would otherwise have to infer.
4. Union the rows. **Drop any row already in the changed set** — you have already touched it.
5. Dedupe by path, keeping the maximum `rankScore` and accumulating `predictedBy`. Sort by
   `rankScore` descending, then by `predictedBy.length` descending, then `compare(path)` — a file
   three separate changes all pull on is stronger evidence than one a single change pulls on.
6. Partition on `isTestPath` (`noise.ts`) into `source` and `tests`. The `tests` half is what the
   completion gate wants: *these tests historically move with what you changed.*
7. Attach `VaultMatch[]` per row, `cited` first.

**Honest empty.** When the changed set is non-empty but every row is empty, the CLI must render
`doctor`'s history verdict alongside, so a squash-collapsed repo reads as *missing evidence, not
evidence of absence* — the `knowledge-explorer` skill's own phrasing.

**Why a separate module rather than growing `cli.ts`.** `cli.ts` is 746 lines, already the largest
file in the package. The git-range read and the union/dedupe logic are independently testable and
belong together; `cli.ts` gets only argument parsing and rendering, as it does for every other
command.

### Unit 3 — `render.ts` and `drift.ts` (edits)

**Module purpose lines in `map.md`.** Each module row gains a second line: the owning mission and
criterion resolved through `own` (labelled `provenance` or `predicted`) and the highest-confidence
`cited` vault note, when either exists.

```
- **packages/graph** [layer 2] — 31 source, 12 test co-changed files
  - M3 - Drift, doctor and the shipped CLI (provenance) — see
    practices/graph-module-sort-uses-community-not-declared-count.md
```

**The truncation hazard this introduces.** `render.ts` currently assumes one module renders one
line, and slices two parallel lists — `lines` and `ranked` — with the same `keptModules` counter.
Those slices must stay in step or the dangling-reference invariant that `visibleEdges`,
`visibleSets` and `shownModules` exist to hold breaks silently, emitting an edge or a working set
naming a module with no heading — in a committed artifact an agent loads as architecture truth.

Fix: keep `lines` at **one entry per module**, where an entry is a multi-line string. Slice
semantics stay per-module, so `lines.slice(0, keptModules)` and `ranked.slice(0, keptModules)`
remain the same set. The shrink loop already compares *rendered line counts* rather than item counts
— a deliberate fix for exactly this class of bug when working sets were added — so it costs the
enrichment correctly with no further change.

**`drift` vault marking.** Each reported pair gains `[known: <note path>]` when a single vault note
cites both files, and nothing when none does. An unmarked pair with strong support is a promotion
candidate by construction: coupling the history proves and the vault has not recorded.

`architecture/dual-schema-entity-io.md` cites both `entity-io.mjs` and `entity-schema.ts`, and that
pair is the flagship example in `docs/octograph.md`. **It must light up as `known` on the first
run.** If it does not, the citation matcher is wrong, and we learn that immediately rather than
after shipping.

**Report-only. Nothing writes to the vault.** No stub generator, no `scripts/` directory, no sixth
pack skill, no `OCTOBOTS_SKILLS` roster change. `knowledge-explorer`'s charter is reading; promotion
stays with the agent through the existing `knowledge-curation` flow.

---

## CLI surface

```
octograph impact <path>                    # unchanged
octograph impact --diff                    # branch scope (default): merge-base(main,HEAD)..HEAD + uncommitted
octograph impact --diff --staged
octograph impact --diff --worktree
octograph impact --diff --since <rev>
octograph impact --diff --base <ref>       # default: main
```

`--diff` and a positional `<path>` are **mutually exclusive** — supplying both is a usage error, not
a silent precedence rule. That follows the existing parser's "recognise, don't guess" convention,
which already rejects an extra positional on `own` rather than picking one.

`--json` is supported, as on every other command.

New config keys in `octograph.yaml`, both optional, both carrying their reasoning in the file as
every existing key does:

| key | default | meaning |
|---|---|---|
| `diffBase` | `main` | the ref `--diff` measures a branch against |
| `vaultPath` | `.agents/knowledge` | where the vault lives |

---

## Skills and the pack

**No new skill, and no new scripts.** Of the five pack skills only `mission-planner` has a
`scripts/` directory, because it *writes* board YAML and needs a dependency-free writer.
`knowledge-explorer` ships `SKILL.md` alone: it reads, and its executable is already
`octograph.mjs`. Every capability here is a new command on that same binary.

Prose edits only:

- `knowledge-explorer/SKILL.md` — one row in the query ladder (`impact --diff`), and a sentence
  saying `drift` now reports whether a coupling is already documented.
- `mission-execution/SKILL.md` — run `impact --diff` before declaring a task done.
- `mission-completion-gate/SKILL.md` — the `tests` half of the answer feeds the gate's coverage
  question.

**The version cohort is not optional.** Per
`.agents/knowledge/architecture/pack-version-is-one-unit.md` (verified 2026-08-13), touching
`packages/graph` regenerates `octograph.mjs`, which obliges the whole eleven-file cohort in the same
PR: `OCTOBOTS_PACK_VERSION`, all five `SKILL.md` `version:` fields, three banner comments, the
machine-stamped payload (`node scripts/graph-payload.mjs --write`, never hand-edited), and a new
sha256 entry in `graph-payload-versions.json`. v51 → v52. A reviewer asking for that diff to be
narrowed is asking for a red CI run.

---

## Testing

Fixture-tree unit tests, matching the rest of `packages/graph`.

- **`vault.ts`** — absent directory; empty directory; malformed frontmatter; a note citing a path
  that does not exist (dropped); a note citing an absolute path and a `../` path (both dropped, per
  `repoRelative`); a note citing two paths (both matched); one note, two modes, never blended.
- **`diff-impact.ts`** — empty changed set; changed set entirely excluded by `excludePaths`; a row
  that is itself in the changed set (dropped); a row predicted by two changed files (ranks above an
  equally-scored row predicted by one); source/test partition; a path containing a newline survives
  the `-z` read and renders escaped through `oneLine`.
- **`render.ts`** — a module with a purpose line and one without; the budget shrink loop under
  enrichment, asserting no edge or working set ever names a module without a heading (the existing
  dangling-reference tests extended, not replaced).
- **`drift.ts`** — a pair cited by one note (`known`); a pair each of whose files is cited by a
  *different* note (not `known` — the claim is about the pair, not the files).
- **Calibration, against the real vault, not a fixture.** The predicted tier is scored against this
  repo's 8 provenance-attributed tasks. Synthetic fixtures never contain sentence-named files, which
  is precisely how the original lexical confound stayed invisible until it met the real corpus. This
  test is the gate on whether the predicted tier ships at all.
- **`cli.ts`** — `--diff` with a positional is a usage error; `--json` shape; exit codes unchanged.
- **Pack cohort** — `packStatus(repo).upToDate === true` after `installPack`, and
  `graph-payload.test.ts` green against the new recorded hash.

---

## Out of scope

- Writing vault notes. Report-only, decided explicitly.
- A module-graph webview. Octograph's audience is agents; the visual belongs to a separate decision.
- Tours / onboarding walks. `map.md` is already ordered by module PageRank; a tour would mostly
  re-serialise it.
- Any LLM, embedding, network call, or source parsing.
- Correcting the stale gap paragraph in `.agents/knowledge/README.md` — file it separately.
