# knowledge-explorer — design

**Date:** 2026-08-13
**Status:** approved, ready to plan

## The problem

Answering *"what do we already know about this area?"* is mandatory work before planning,
implementing, testing or diagnosing anything in an unfamiliar part of a repository. Today an agent
answers it with greps.

Two sources exist and neither is reachable by an agent as a discipline:

- `.agents/knowledge/` — the committed, cross-role, verified vault. Documented in its own
  `README.md` and in `AGENTS.md`, but nothing tells an agent *when* to read it or how it relates to
  the work in front of them.
- **octograph** (`packages/graph`) — six commands over the co-change graph mined from git history.
  `docs/octograph.md` documents what each command answers. The only thing that points an agent at
  it is `hooks/primer.mjs`, which injects `map.md` when a built artifact happens to exist. Nothing
  tells an agent to run `impact` before an edit or `drift` before a decomposition.

The consequence is an incomplete answer that looks complete: a change that misses a coupled file, a
decomposition that splits one piece of work into three, a QA pass that never learns which paths are
historically fragile.

## The premise

**The vault is obligatory. The graph is optional.**

The vault is the source of record; consulting it is not conditional on anything. octograph is an
instrument that produces evidence the vault cannot hold on its own — which files actually move
together, who owns a path, whether a decomposition is clean. Where it is installed, the answer is
richer. Where it is absent or its history is too thin to mean anything, the answer is still valid,
just thinner, and the skill says so rather than pretending.

The two belong in one skill because of the loop between them: **the graph is how the vault grows.**
A verified, durable, cross-role graph finding is promoted into the vault, so the next reader's
mandatory tier already contains it and the optional tier is not re-paid.

## Shape

A standalone skill, `knowledge-explorer`, shipped in the Octobots pack
(`resources/octobots-pack/skill/knowledge-explorer/`), installed to `.claude/skills/` alongside the
`octograph.mjs` that *Octobots: Install Graph* already places at `.claude/skills/graph/`.

Standalone rather than folded into existing skills: the question it answers is asked by several
roles at different moments, and it must be invocable on its own. Existing pack skills gain a
one-line pointer, not a gate.

### Tier 1 — mandatory

- `.agents/knowledge/README.md` plus the folder covering what is being touched.
- `CLAUDE.md` / `AGENTS.md`.
- The `.octobots/` board, as recorded intent.

Never skipped, never conditional. If the vault answers the question, tier 2 may be unnecessary.

### Tier 2 — optional enrichment

octograph. Locate the CLI in this order:

1. `.claude/skills/graph/octograph.mjs` — the installed payload.
2. `apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs` — this repository's own
   bundled copy.
3. Neither: emit one line naming *Octobots: Install Graph*, and continue with tier 1 only.

**Never build and never install.** `impact`, `drift` and `own` call `analyze()` against `git log`
on every invocation (`packages/graph/src/cli.ts`) — no artifact is required and a query costs
~0.2 s on this repository. Only `map` writes `map.md`/`clusters.json`, and that is the installer's
and the primer's business, not this skill's.

### Role-shaped entry points

| Asking | The question | Tier 1 | Tier 2 |
|---|---|---|---|
| tech-lead, planning | What is the real shape here, and is my split clean? | `architecture/`, the board | `map`, `drift`, `conflicts <mission>` |
| dev, implementing | What must move with this, and what will bite me? | `architecture/`, `practices/` | `impact <path>`, `own <path>` |
| QA, testing | Where is the risk surface, what is historically fragile? | `testing/` | `impact` over the changed set, `drift` |
| RCA | What moved with the broken thing, and do we know why? | all folders | `impact`, `own`, `drift` |

### Tier 2's discipline

This is the part that cannot be learned from `docs/octograph.md`, and the reason the skill exists
rather than a doc link.

**`doctor` once per session, before believing any zero.** It is the only thing that says whether an
empty result means anything. On this repository it reports `degraded` — 31 analysable commits,
squash-merged — which makes an empty `impact` *missing evidence*, not *evidence of absence*.

**Reading a zero.** `(no coupled files)` has three causes and the CLI cannot distinguish them:

1. the path is in `excludePaths` — `.claude/`, `.octobots/`, `.agents/`, `dist/`, `build/` and
   others are excluded **by default** (`octograph.yaml`);
2. the path is new or untracked — `harvest` reads `git log`, so an untracked file does not exist to
   the graph;
3. support fell below `minSupport` (default 2).

Before trusting a zero: check the path against `octograph.yaml`'s `excludePaths`, and run
`git log --oneline -- <path> | wc -l`. **If the path is excluded, query its unexcluded twin.**

Measured on this repository, 2026-08-13:

```
$ octograph impact .claude/skills/mission-planner/scripts/validate.js
(no coupled files)                       # .claude/ is excluded — not an answer

$ octograph impact apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/validate.js
packages/board/src/validate.ts                        npmi=0.857  support=2
apps/…/octobots-pack/skill/mission-planner/scripts/show.js  npmi=0.853  support=2
packages/board/src/write.ts                           npmi=0.704  support=3
packages/board/src/types.ts                           npmi=0.710  support=2
packages/board/test/scripts-smoke.test.ts             npmi=0.599  support=2
…all four pack SKILL.md files…
```

Same file, two paths, and only one of them is in the graph.

**Verify before reporting.** The graph proposes; opening the file proves. Carry `support` and
`nPMI` into the report rather than laundering a support-2 row into a certainty.

**Budget.** At most one `impact` per file being changed, plus at most one `drift` per question.
`--json` only when the output will actually be parsed; the default text form is more compact.

### Closing the loop

For each confirmed coupling, grep `.agents/knowledge/` for a note that explains *why* — e.g.
`architecture/dual-schema-entity-io.md` explains the `entity-io.mjs ↔ entity-schema.ts` row `drift`
returns. Where no note exists and the finding passes the vault's four admission tests (cross-role,
verified, durable, costly to rediscover), hand it to `knowledge-curation`.

Both steps are skipped **silently** when `.agents/` is absent: the pack installs into workspaces
that have no vault, and a missing optional layer is not an error.

### Output contract

1. **What we know** — from the vault, each claim cited to its note.
2. **What the graph adds** — path, evidence (`support`/`nPMI`), and how it was verified.
3. **What neither could see** — excluded paths, degraded history, absent instrument. Stated
   explicitly, always. An answer that silently omits its own blind spots is the failure this skill
   exists to prevent.

## Wiring

- New skill directory `resources/octobots-pack/skill/knowledge-explorer/SKILL.md`.
- `OCTOBOTS_SKILLS` in `apps/vscode-extension/src/host/octobots-skill.ts` gains
  `"knowledge-explorer"`. The roster is explicit and `packStatus` checks every entry, so an
  unlisted skill is never installed.
- **Version bump 49 → 50, as one unit** (`packStatus` requires every marker to equal
  `OCTOBOTS_PACK_VERSION`):
  - five `SKILL.md` frontmatter `version:` lines (four existing plus the new one);
  - four `// octobots-pack-version:` banners — `hooks/primer.mjs`, `tokenomics/run.mjs`,
    `tokenomics/backfill-worklog-sha.mjs`, `graph/octograph.mjs`;
  - a new `"50"` entry in `apps/vscode-extension/scripts/graph-payload-versions.json`. The banner
    lives inside the bundle, so re-bundling at v50 changes its bytes and `graph-payload.test.ts`
    fails until the hash is recorded.
- One-line pointers into the new skill from `mission-planner` (before decomposing),
  `mission-execution` (before the first edit of a task) and `mission-completion-gate` (QA phase).
  Pointers, not gates.
- `docs/octograph.md` gains a short pointer describing how an agent should reach for the skill.

## Validation

Issue [#60](https://github.com/onetest-ai/octoshell/issues/60) — *a mission should be allowed more
than one workflow* — is the test case, because its true change set is knowable in advance:

- `add-workflow.js` and `validate.js` under `resources/octobots-pack/…`;
- `workflow-designer/SKILL.md` and `mission-planner/SKILL.md`;
- `packages/board/src/validate.ts`, for validator parity — the rule exists there too, which the
  issue does not notice;
- `packages/board/test/validate.test.ts`, which pins it;
- the pack version-bump cohort that editing any pack `SKILL.md` obliges.

> **Corrected 2026-08-13, after the run.** An earlier draft claimed the change set was doubled
> because each script also exists at `.claude/skills/…`. It is not: `.claude/` is gitignored in this
> repository and regenerated by `installPack`, so those copies are install output, not change
> targets. The doubling is real in a consumer repository that vendors the pack — where #60 was
> originally hit — but not here.

Two runs of the same question, measured against each other: a grep-only baseline, and a
tier-1-then-tier-2 run. Record files found and tokens spent for each.

Two pass conditions:

1. The reported footprint covers the true change set.
2. **Every zero is reported as invisibility, not as absence** — the path was excluded, untracked, or
   below `minSupport`, and the report says which. A run that silently treats an empty result as "no
   coupling" is a failure even if condition 1 passes.

Result: `docs/superpowers/spikes/2026-08-13-knowledge-explorer-vs-issue-60.md`.

## Out of scope

`(no coupled files)` meaning three different things is arguably a defect in
`packages/graph/src/cli.ts` — an excluded path could be named as excluded. Filed as a board bug and
a GitHub issue rather than folded into a skill's design.
