# Octobots

> Plan and run AI coding work as a board that lives in your repository — and let CLI agents drive
> the same board you're looking at.

Octobots is a VS Code extension that turns a folder's `.octobots/` directory into a project board:
**campaigns → missions → tasks**, plus **bugs** and **workflows**. Every entity is a plain YAML
file on disk.

There is no database and no server. **The files are the board.** That is what makes it diffable,
reviewable in a pull request, survivable across machines, and safe for several agents to edit at
once.

---

## The problem it solves

You can already ask an AI agent to write code. What you cannot easily do is:

- **Say what "done" means** in a way the agent is actually held to, rather than hoping.
- **Keep the plan** when the chat window closes. A decision that lives only in a transcript is gone.
- **Run more than one agent** without them overwriting each other's understanding of the work.
- **Know what it cost** — in tokens, in money, in wall-clock — per mission rather than per month.

Octobots answers those by putting the work *in the repository*, next to the code, in files both a
human and an agent can read and write.

---

## Install

Install the extension, open a folder, and use the Command Palette.

| First run | |
|---|---|
| `Octobots: New Campaign` | Creates `.octobots/campaigns/<slug>/campaign.yaml` |
| `Octobots: Install Workflow Pack` | Installs the skills and hooks that let CLI agents drive the board |

The **Octobots** icon in the activity bar shows the campaign tree. Clicking any entity opens a
detail panel where you can edit its status, acceptance criteria, notes and attached documents.

---

## The board

```
.octobots/campaigns/<campaign>/campaign.yaml
                              /missions/<mission>/mission.yaml
                                                /tasks/<task>/task.yaml
                                                /bugs/<bug>/bug.yaml
                                                /workflows/<name>/workflow.js
```

Four levels, each a folder with one YAML file:

- **Campaign** — an outcome. "Ship a code architecture graph."
- **Mission** — an independently shippable slice of it, with its own acceptance criteria.
- **Task** — one small, verifiable unit: one branch, one small PR.
- **Bug** — reproduction steps, expected, actual, root-cause analysis. Filed against whichever
  parent owns it.

**Children are folder-derived.** A campaign never lists its missions; a mission never lists its
tasks. Status lives in the child's own file. That removes the entire class of bug where a parent's
index disagrees with what is on disk — and it is why two agents can add tasks concurrently without
conflicting.

Every task carries at least one **acceptance criterion**. That is enforced, not encouraged: a task
with no checkable definition of done cannot be gated, and gating is the point.

### Attached documents

Longer artifacts — a spec, an implementation plan, a design note — attach to a campaign or mission
either as a link or as a file living in the entity's own folder. A plan that exists only in a
closed chat is lost work; attached, it is what makes a mission resumable months later.

---

## In the editor

| Command | What it does |
|---|---|
| `New Campaign` · `New Mission in this Campaign` | Create board entities |
| `Add File to Campaign` | Attach a document |
| `New Workflow` · `Delete Workflow` | Author an execution graph for a mission or campaign |
| `Refresh Campaigns` | Re-read the tree from disk |
| `Delete Campaign` / `Mission` / `Task` / `Bug` | Remove an entity and its folder |
| `Install Workflow Pack` | Install the agent-facing skills and hooks |
| `Install SDLC Team Bundle` · `Update SDLC Team Bundle` | Install role agents (tech-lead, QA, devs…) |
| `Install Graph` · `Rebuild Graph` | Build the architecture map — see [octograph](docs/octograph.md) |
| `Tokenomics` · `Export Tokenomics Report` | What the work cost |
| `Open Settings` | Extension settings |

Edits made on disk — by you, by an agent, by `git checkout` — are picked up automatically. The
watcher waits for git to go quiet first, so a rebase or a branch switch does not produce a storm of
half-read states.

---

## Driving it from a CLI agent

`Octobots: Install Workflow Pack` copies a set of skills and hooks into `.claude/`, teaching an
agent how to read and drive the board. Four skills, each for a different moment:

| Skill | When |
|---|---|
| **mission-planner** | Turning an intent into campaigns, missions and tasks with real acceptance criteria |
| **workflow-designer** | Deciding *how* a mission runs — phases, which agents, what is parallel |
| **mission-execution** | Driving a planned task to a merged, verified PR |
| **mission-completion-gate** | The blocking gate a mission must pass before it is done |

And three hooks:

- **primer** — injects board context (and the architecture map, if built) at session start, so an
  agent begins oriented instead of guessing.
- **work-log** — records `session → mission → branch` as work happens. This is what makes cost
  attribution and provenance possible later.
- **mission-gate** — fires when a mission is flipped to `done`, and hands the agent the completion
  gate rather than trusting that it remembered.

### How a mission actually runs

Each task, in order, in one working tree on one branch:

1. **Plan** — a tech lead produces the concrete approach and a test list.
2. **Build** — TDD, on a task branch cut from the mission branch.
3. **QA** — the acceptance criteria checked against observable behaviour.
4. **Review** — a blocking review of the task's diff, with a security lens.
5. **Land** — a small PR into the mission branch, merged on green.

Then, once per mission, a **completion gate** that a per-task loop structurally cannot replace:
black-box QA against the *mission's* criteria by someone who never saw the diff, a live end-to-end
pass, and a review of the whole branch at once.

> Tasks are sequenced, never parallel. They share one working tree and one branch — and isolation
> comes from branches, not from a second checkout. A git worktree would carry none of the
> gitignored working state an agent actually needs: no board, no installed skills, no dependencies.

---

## octograph — the architecture map

Octobots ships a tool that mines your git history for **which files actually change together** —
the coupling no import edge explains, because sometimes there is nothing to import.

```
apps/…/mission-planner/scripts/entity-io.mjs  <->  packages/board/src/entity-schema.ts
```

One schema, two implementations, no possible import between them. Static analysis cannot find that.
Git can.

`Octobots: Install Graph`, then `Rebuild Graph` as history moves on. It answers *what is this
codebase*, *if I change this what else moves*, *what is coupled that nothing imports*, and — with a
board — *which mission owns this file and which criterion it satisfies*.

Full guide: **[docs/octograph.md](docs/octograph.md)**.

---

## Tokenomics

`Octobots: Tokenomics` reports what the work cost: tokens, money, turns, subagent dispatches and
net lines changed, **per mission**.

It reads agent transcripts, which live outside the repository and are pruned without warning — so
collection happens at the mission gate, the last moment the data exists. Costs are re-priced from
raw token counts on every run, so a price-table update does not require re-reading anything.

The one thing it cannot derive is **effort**: how long the work would have taken a person, with no
AI. That is authored on the board at planning time, and it is what makes cost-per-size meaningful
rather than circular.

---

## Why it is built this way

**Disk is the source of truth.** Reading the board is a pure rebuild from files, never a cached
projection that can drift. Any tool that can write a file can drive Octobots.

**No server, no daemon, no database.** Nothing to run, nothing to migrate, nothing to keep alive.

**Safe for concurrent agents.** Folder-derived children and per-entity status mean two agents
editing different entities never touch the same bytes.

**Acceptance criteria are the contract.** They are what QA verifies, what the gate blocks on, and
what `octograph own` traces code back to. A criterion that cannot be checked is a planning defect,
not a formality.

**Say what you observed, not what you assume.** Every surface that makes a claim states how it
knows — `provenance` versus `predicted`, evidence versus guess. Where a tool cannot know, it says
so and suppresses the output rather than inventing structure.

---

## Repository layout

This repo is a pnpm + turborepo monorepo:

| Path | |
|---|---|
| `apps/vscode-extension` | The extension: host (Node) + webview (React, Tailwind on VS Code theme tokens) |
| `packages/board` | The file-based board model — parse, validate, write |
| `packages/graph` | octograph: co-change mining, the CLI, and the bundled artifact |
| `packages/tokenomics` | Transcript pricing and per-mission rollup |

```bash
pnpm build       # tsc per package; esbuild + vite for the extension
pnpm test        # vitest
pnpm lint
pnpm typecheck
```

Launch the extension with **Run Octoshell Extension** in `.vscode/launch.json` (F5) — an Extension
Development Host, not a `dev` script.

> Changing a package's public types? Dependents read the built `dist/`, not source. Run
> `pnpm build` before `typecheck`/`test` in dependents, or they will see stale `.d.ts`.

---

## Contributing

Issues and pull requests welcome. The conventions that matter:

- **ESM + NodeNext.** Relative imports carry the `.js` extension even from `.ts` source.
- **Never hardcode colours** in the webview — use the CSS-variable VS Code theme tokens, so the UI
  follows the user's theme.
- **Scoped staging.** `git add <paths>`, never `git add -A`: `.octobots/` and `.claude/` are
  gitignored and the tree may hold work in progress.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
