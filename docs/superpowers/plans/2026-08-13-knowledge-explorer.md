# knowledge-explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fifth Octobots pack skill, `knowledge-explorer`, that makes "what do we already know about this area" a two-tier discipline — `.agents/knowledge/` mandatory, octograph optional enrichment — and validate it against issue #60.

**Architecture:** A single `SKILL.md` under `resources/octobots-pack/skill/knowledge-explorer/`, added to the explicit `OCTOBOTS_SKILLS` roster so `installPack` copies it and the parameterised convention tests apply to it. Adding a skill forces a pack-version bump, which is a whole-pack unit: five frontmatter lines, three hand-edited banners, one machine-stamped banner, and one new hash entry in the payload version lock. Sibling skills gain pointer lines, not gates.

**Tech Stack:** TypeScript (ESM + NodeNext), vitest, pnpm + turborepo. No new dependencies.

## Global Constraints

- **Pack version moves as one unit.** `packStatus` compares every marker to `OCTOBOTS_PACK_VERSION`; a single stale marker reports the whole pack out of date. Current value **49** → new value **50**.
- **`graph/octograph.mjs` is machine-generated.** Never hand-edit its banner. Regenerate with `node scripts/graph-payload.mjs --write` from `apps/vscode-extension/`.
- **Convention tests are parameterised over `OCTOBOTS_SKILLS`.** Every skill's `SKILL.md` must match `^name:\s*<dir-name>\s*$`, carry `version: 50`, have a description matching `^description: Use when `, and contain the literal words `Not for` in that description.
- **The skill must degrade silently.** No `.agents/` directory and no octograph payload are both normal states in a workspace that installs the pack. Neither is an error.
- **Relative imports carry `.js`** even from `.ts` sources. No source file in `packages/graph/src` may read `Date.now()`/`Math.random()` (`conventions.test.ts` fails the build on it) — irrelevant here, but do not "fix" anything in that package as a side quest.
- `docs/superpowers/` is gitignored: committing anything under it needs `git add -f`.

---

### Task 1: Ship the skill in the pack

**Files:**
- Create: `apps/vscode-extension/resources/octobots-pack/skill/knowledge-explorer/SKILL.md`
- Modify: `apps/vscode-extension/src/host/octobots-skill.ts` (`OCTOBOTS_PACK_VERSION`, `OCTOBOTS_SKILLS`)
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/SKILL.md:4`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/workflow-designer/SKILL.md:4`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-execution/SKILL.md:4`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-completion-gate/SKILL.md:4`
- Modify: `apps/vscode-extension/resources/octobots-pack/hooks/primer.mjs:1`
- Modify: `apps/vscode-extension/resources/octobots-pack/tokenomics/run.mjs:2`
- Modify: `apps/vscode-extension/resources/octobots-pack/tokenomics/backfill-worklog-sha.mjs:2`
- Regenerate: `apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs`
- Modify: `apps/vscode-extension/scripts/graph-payload-versions.json`
- Test: `apps/vscode-extension/test/octobots-skill.test.ts` (existing, parameterised — no edit needed)

**Interfaces:**
- Consumes: nothing.
- Produces: the string `"knowledge-explorer"` as a member of `OCTOBOTS_SKILLS`, and `OCTOBOTS_PACK_VERSION === 50`. Task 2 relies on the skill directory existing at `resources/octobots-pack/skill/knowledge-explorer/`.

- [ ] **Step 1: Add the roster entry so the convention tests go red**

In `apps/vscode-extension/src/host/octobots-skill.ts`:

```ts
export const OCTOBOTS_SKILLS = ["mission-planner", "workflow-designer", "mission-execution", "mission-completion-gate", "knowledge-explorer"] as const;
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `pnpm --filter @octoshell/vscode-extension test -- octobots-skill`
Expected: FAIL — `ENOENT` reading `resources/octobots-pack/skill/knowledge-explorer/SKILL.md` in the four `it.each(OCTOBOTS_SKILLS)` cases.

- [ ] **Step 3: Write the skill**

Create `apps/vscode-extension/resources/octobots-pack/skill/knowledge-explorer/SKILL.md` with exactly this content:

````markdown
---
name: knowledge-explorer
description: Use when you need to know what is already known about part of a repository before acting on it — orienting in unfamiliar code, planning a decomposition, judging what a change will touch, choosing what to test, or tracing a bug's blast radius. Reads the committed knowledge vault first, then enriches it with octograph's co-change evidence when that instrument is installed. Not for planning the work itself (that is mission-planner), not for designing how it runs (that is workflow-designer), and not for building a planned task through to a merged PR (that is mission-execution).
version: 50
---

<!-- Auto-generated by Octobots. Re-installed from the Octoshell extension; edits may be overwritten on update. -->

# knowledge-explorer

Answering **"what do we already know about this area?"** is mandatory work before you plan,
implement, test or diagnose anything you did not write yourself. This skill is how you answer it
without thirty greps, and — more importantly — how you report what you *could not* see.

Two sources, and they are not equal.

```
.agents/knowledge/    the committed, verified vault     OBLIGATORY   read it, always
octograph             the co-change graph from git      OPTIONAL     use it where installed
```

The vault is the source of record. octograph is an **instrument**: it produces evidence the vault
cannot hold on its own — which files actually move together, who owns a path, whether a
decomposition is clean. Where it is installed the answer is richer. Where it is absent, or its
history is too thin to mean anything, the answer is still valid — just thinner, and you say so.

The loop between them is the point: **the graph is how the vault grows.** A verified, durable,
cross-role graph finding gets promoted into the vault, so the next reader's mandatory tier already
contains it and nobody pays for the discovery twice.

## Tier 1 — the vault (never skipped)

1. `.agents/knowledge/README.md` — the charter and the folder map.
2. The folder covering what you are touching: `architecture/`, `frontend/`, `services/`,
   `integrations/`, `practices/`, `testing/`, `security/`.
3. `CLAUDE.md` / `AGENTS.md` at the repo root.
4. The `.octobots/` board, as recorded intent — what was planned, and why.

If `.agents/` does not exist, fall back to `CLAUDE.md`/`AGENTS.md` and the board, and note in your
report that this repository has no knowledge vault. Do not treat its absence as an error.

**If the vault answers the question, stop.** Tier 2 costs tokens and it is not always needed.

## Tier 2 — octograph (where installed)

### Find it, never build it

Try, in order:

1. `.claude/skills/graph/octograph.mjs` — the installed payload.
2. `apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs` — present only when you are
   working inside the octoshell repository itself.

Neither: say once that octograph is not installed and that **Octobots: Install Graph** installs it,
then answer from tier 1 alone.

**Never run `map`, `setup`, or any install.** `impact`, `drift` and `own` analyse `git log` on every
invocation — no artifact is required, and a query costs roughly 0.2 s. `map` writes artifacts and
belongs to the installer and the session primer, not to you.

Invoke it as `node <path-to-octograph.mjs> <command>` from the repository root.

### Run `doctor` once, before believing anything

```
node <octograph> doctor
```

It grades the history and names every degradation. This is the only thing that tells you whether an
empty result means anything. A repository that squash-merges may report `degraded` with a few dozen
analysable commits — there, an empty `impact` is **missing evidence, not evidence of absence**, and
your report must say which.

Run it once per session and reuse the answer.

### The query ladder

| Question | Command |
|---|---|
| What else moves when this file moves? | `impact <path>` |
| What is coupled across modules that nothing imports? | `drift` |
| Which mission and criterion does this path serve? | `own <path>` |
| Is this decomposition clean, or is it one piece of work split three ways? | `conflicts <mission>` |
| What is this codebase, in 2,000 tokens? | `map` — **only** if `map.md` already exists; read it, do not generate it |

`own` and `conflicts` need an `.octobots/` board and exit non-zero without one.

**Budget:** at most one `impact` per file you actually intend to change, plus at most one `drift`
per question. Use `--json` only when you will parse the output — the default text form is more
compact.

### Reading a zero — the trap this skill exists for

`(no coupled files)` has three causes and the CLI cannot distinguish them:

1. **The path is excluded.** `octograph.yaml`'s `excludePaths` drops paths at the graph's input.
   The defaults include `.claude/`, `.octobots/`, `.agents/`, `.github/`, `dist/`, `build/`,
   `node_modules/` and more. An excluded path is not in the graph at all.
2. **The path is new or untracked.** `harvest` reads `git log`; a file with no commits does not
   exist to the graph.
3. **Support fell below `minSupport`** (default 2) — the pair was seen once, which is coincidence.

Before you report a zero as an answer:

```bash
grep -n -A40 '^excludePaths:' octograph.yaml     # is this path's prefix listed?
git log --oneline -- <path> | wc -l              # does it have history at all?
```

**If the path is excluded, query its unexcluded twin.** A vendored or installed copy of a file often
lives outside the exclusion while the working copy lives inside it. Measured on octoshell,
2026-08-13:

```
$ node <octograph> impact .claude/skills/mission-planner/scripts/validate.js
(no coupled files)                                    # .claude/ is excluded — this is not an answer

$ node <octograph> impact apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/validate.js
packages/board/src/validate.ts       npmi=0.857  support=2
…/scripts/show.js                    npmi=0.853  support=2
packages/board/src/write.ts          npmi=0.704  support=3
packages/board/src/types.ts          npmi=0.710  support=2
packages/board/test/scripts-smoke.test.ts  npmi=0.599  support=2
```

Same file, two paths, and only one of them is in the graph.

### Verify before you report

The graph proposes; opening the file proves. For every row you intend to act on, read the file and
judge it: a real twin, contract or protocol partner — or two files that happened to move together.
Carry `support` and `nPMI` into your report. A row with `support=2` is a hint; do not launder it
into a certainty by omitting the number.

## Who is asking

| You are | The question | Tier 1 | Tier 2 |
|---|---|---|---|
| a **tech lead** planning | What is the real shape here, and is my split clean? | `architecture/`, the board | `drift`, `conflicts <mission>` |
| a **developer** implementing | What must move with this, and what will bite me? | `architecture/`, `practices/` | `impact <path>`, `own <path>` |
| **QA** testing | Where is the risk surface, and what is historically fragile? | `testing/` | `impact` over the changed set, `drift` |
| running an **RCA** | What moved with the broken thing, and do we already know why? | every folder | `impact`, `own`, `drift` |

## Close the loop

For each coupling you confirmed, grep the vault for a note that explains **why** it exists:

```bash
grep -ril "<the-other-filename>" .agents/knowledge/
```

A hit is your explanation, and often states the rule the coupling obeys. No hit, and the finding
passes all four of the vault's admission tests — cross-role, verified, durable, costly to
rediscover — then hand it to `knowledge-curation` so the next reader gets it from tier 1.

Skip this section silently when `.agents/` is absent.

## What you report

Three parts, always all three:

1. **What we know** — from the vault, each claim cited to the note it came from.
2. **What the graph adds** — path, evidence (`support` / `nPMI`), and how you verified it.
3. **What neither could see** — excluded paths you had to work around, degraded history, an absent
   instrument, a vault this repository does not have.

Part 3 is not optional and not a footnote. An answer that silently omits its own blind spots is
exactly the failure this skill exists to prevent: it reads as complete, and the reader has no way
to tell that it is not.
````

- [ ] **Step 4: Bump the pack version and every hand-edited marker**

In `apps/vscode-extension/src/host/octobots-skill.ts`:

```ts
export const OCTOBOTS_PACK_VERSION = 50;
```

Set `version: 50` on line 4 of each of the four existing pack `SKILL.md` files
(`mission-planner`, `workflow-designer`, `mission-execution`, `mission-completion-gate`).

Set the banner to `50` in each of these three files (line 1 of the first, line 2 of the others):

```
// octobots-pack-version: 50
```

- `resources/octobots-pack/hooks/primer.mjs`
- `resources/octobots-pack/tokenomics/run.mjs`
- `resources/octobots-pack/tokenomics/backfill-worklog-sha.mjs`

Do **not** hand-edit `resources/octobots-pack/graph/octograph.mjs` — the next step regenerates it.

- [ ] **Step 5: Regenerate the machine-stamped graph payload**

```bash
cd apps/vscode-extension && node scripts/graph-payload.mjs --write
```

Expected: `octograph payload written: …/resources/octobots-pack/graph/octograph.mjs (N bytes)`.
Confirm the banner moved:

```bash
head -2 apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs
```

Expected line 2: `// octobots-pack-version: 50`

- [ ] **Step 6: Record the payload hash against version 50**

```bash
shasum -a 256 apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs
```

Add the resulting hex digest to `apps/vscode-extension/scripts/graph-payload-versions.json` as a new
last entry, keeping the existing ones untouched:

```json
  "49": "9082dc929ab0655b636558e91eba73e55b8045114ce555f7cae6560822537c84",
  "50": "<the digest printed above>"
```

- [ ] **Step 7: Run the extension suite to verify it passes**

Run: `pnpm --filter @octoshell/vscode-extension test`
Expected: PASS, including `octobots-skill.test.ts`'s five parameterised convention cases and
`graph-payload.test.ts`'s "sha256 is recorded against the CURRENT pack version".

If `graph-payload.test.ts` fails on the freshness gate, re-run Step 5 — the payload was regenerated
before the version constant was bumped.

- [ ] **Step 8: Commit**

```bash
git add apps/vscode-extension/resources/octobots-pack apps/vscode-extension/src/host/octobots-skill.ts apps/vscode-extension/scripts/graph-payload-versions.json
git commit -m "feat(pack): knowledge-explorer — the vault is obligatory, the graph enriches it"
```

---

### Task 2: Route the sibling skills to it

**Files:**
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/SKILL.md` (before `## Layout`)
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-execution/SKILL.md` (`## Skill companions`)
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-completion-gate/SKILL.md` (`## Companions`)
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/workflow-designer/SKILL.md` (`## When a workflow is worth writing`)
- Modify: `docs/octograph.md`
- Test: `apps/vscode-extension/test/octobots-skill.test.ts` (add one case)

**Interfaces:**
- Consumes: `OCTOBOTS_SKILLS` including `"knowledge-explorer"`, and `PACK_SRC` — both already imported at the top of `octobots-skill.test.ts`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("bundled pack payloads", …)` block in
`apps/vscode-extension/test/octobots-skill.test.ts`:

```ts
  // A skill nothing points at is a skill nothing invokes. knowledge-explorer answers a question the
  // other four each hit at a different moment, so each of them names it — as a pointer, not a gate.
  it.each(["mission-planner", "workflow-designer", "mission-execution", "mission-completion-gate"])(
    "%s points at knowledge-explorer",
    (name) => {
      const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
      expect(skill).toMatch(/knowledge-explorer/);
    },
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @octoshell/vscode-extension test -- octobots-skill`
Expected: FAIL — four cases, each "expected … to match /knowledge-explorer/".

- [ ] **Step 3: Add the pointers**

In `mission-planner/SKILL.md`, immediately **before** the `## Layout` heading:

```markdown
Before you decompose anything you did not write, use the **`knowledge-explorer`** skill: it reads
the repository's knowledge vault and — where octograph is installed — the co-change evidence that
says which files actually move together. Planning a split without it is how one piece of work
becomes three missions.

```

In `mission-execution/SKILL.md`, as the first bullet under `## Skill companions`:

```markdown
- **`knowledge-explorer`** — before your first edit on a task, find out what the repo already knows
  about the files you are about to touch, and what else moves with them.
```

In `mission-completion-gate/SKILL.md`, as a bullet under `## Companions`:

```markdown
- **`knowledge-explorer`** — Sage uses it in phase 2 to size the risk surface: which paths the
  change is historically coupled to, and which of them the QA pass has not touched.
```

In `workflow-designer/SKILL.md`, as the last paragraph of `## When a workflow is worth writing`:

```markdown
If you cannot tell whether the mission's tasks are genuinely independent, use the
**`knowledge-explorer`** skill first — `conflicts <mission>` answers exactly that, and parallelising
tasks that co-change is how a workflow produces merge conflicts on every run.
```

In `docs/octograph.md`, immediately after the `## Using it from the extension` heading's
`### The session primer` subsection, add:

```markdown
### How an agent should reach for it

The primer hands an agent the map; the **`knowledge-explorer`** skill (shipped in the Octobots pack)
is what tells it when to spend a query, how to read an empty result, and what to do with the answer.
The commands below are the instrument; that skill is the discipline for using it.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @octoshell/vscode-extension test -- octobots-skill`
Expected: PASS — all four pointer cases green, and the five convention cases still green.

- [ ] **Step 5: Commit**

```bash
git add apps/vscode-extension/resources/octobots-pack/skill apps/vscode-extension/test/octobots-skill.test.ts docs/octograph.md
git commit -m "feat(pack): point the four sibling skills at knowledge-explorer"
```

---

### Task 3: Validate against issue #60, and file what the validation found

**Files:**
- Create: `docs/superpowers/spikes/2026-08-13-knowledge-explorer-vs-issue-60.md`
- Create: a bug on the `.octobots/` board via `.claude/skills/mission-planner/scripts/add-bug.js`

**Interfaces:**
- Consumes: the skill authored in Task 1. Do not edit it during validation — record what it produced, then change it in a follow-up if it under-performed.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Install the pack locally so the skill is on disk**

`.claude/` is gitignored, so this is working state only — it does not appear in the commit.

```bash
cp -R apps/vscode-extension/resources/octobots-pack/skill/knowledge-explorer .claude/skills/
ls .claude/skills/knowledge-explorer/SKILL.md
```

- [ ] **Step 2: Establish the grep-only baseline**

Answer "what must change to fix issue #60?" using only `grep`/`rg` and file reads. Record the file
list produced and roughly how many tool calls it took. Do not consult octograph.

Issue #60's ask: drop the one-workflow-per-mission restriction — the `mission && existing.length > 0`
guard in `add-workflow.js`, the more-than-one check in `validate.js`, and the doctrine lines in
`workflow-designer/SKILL.md` and `mission-planner/SKILL.md`.

- [ ] **Step 3: Run the skill's procedure**

Tier 1: read `.agents/knowledge/README.md` and `architecture/`; grep the vault for `workflow`.

Tier 2, from the repo root:

```bash
G=apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs
node $G doctor
node $G impact apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/add-workflow.js
node $G impact apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/validate.js
node $G drift | head -20
```

Apply the zero-reading rule to every empty result, and verify every non-empty row by opening the
file.

- [ ] **Step 4: Write the validation record**

Create `docs/superpowers/spikes/2026-08-13-knowledge-explorer-vs-issue-60.md` containing:

- the true change set for #60, established by reading the code;
- the baseline run's file list and cost;
- the skill run's file list and cost;
- **pass condition 1** — did the reported footprint cover the true change set?
- **pass condition 2** — were the `.claude/` twins reported as *invisible to the instrument*
  rather than as *uncoupled*? A run that silently drops four real files while reading as confident
  fails, even if condition 1 passes.
- what the skill got wrong, verbatim, with no softening.

- [ ] **Step 5: File the CLI defect on the board and on GitHub**

`(no coupled files)` means three different things and the CLI distinguishes none of them. That is a
defect in `packages/graph/src/cli.ts`, kept out of this change deliberately.

```bash
node .claude/skills/mission-planner/scripts/add-bug.js \
  --campaign octograph-code-architecture-graph \
  --name "BUG - impact reports an excluded path as uncoupled" \
  --severity medium
```

Then mirror it out:

```bash
gh issue create --repo onetest-ai/octoshell \
  --title "impact/drift report an excluded path as \"(no coupled files)\", identical to genuinely uncoupled" \
  --body "<the board bug's description, plus the two measured commands from the design doc>"
```

Run `node .claude/skills/mission-planner/scripts/validate.js` afterwards and fix anything it reports.

- [ ] **Step 6: Commit**

```bash
git add -f docs/superpowers/spikes/2026-08-13-knowledge-explorer-vs-issue-60.md
git add .octobots
git commit -m "docs(spike): knowledge-explorer measured against issue #60"
```

---

### Task 4: Green the repo and open the PR

**Files:**
- No source changes expected. This task is the verification gate.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a PR into `main`.

- [ ] **Step 1: Build, in dependency order**

Run: `pnpm build`
Expected: PASS. `board`/`tokenomics`/`graph` build before `vscode-extension`; a stale `dist/` is why
`typecheck` is run after this, never before.

- [ ] **Step 2: Typecheck, lint, test the whole monorepo**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: PASS. Note the total test count in the PR body.

- [ ] **Step 3: Verify the pack installs cleanly into a fresh workspace**

The `installPack` test already covers this, but confirm the new skill is in its output:

Run: `pnpm --filter @octoshell/vscode-extension test -- octobots-skill`
Expected: PASS, and `packStatus(repo).upToDate === true` after install — which is only true if all
five `SKILL.md` files, the primer and the tokenomics markers all read `50`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/knowledge-explorer-skill
gh pr create --repo onetest-ai/octoshell --base main \
  --title "feat(pack): knowledge-explorer — the vault is obligatory, the graph enriches it" \
  --body "<design summary, the #60 validation result including both pass conditions, and the test count>"
```
