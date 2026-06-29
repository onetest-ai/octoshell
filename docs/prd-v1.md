# PRD — Octobots (current)

> Status: describes the shipped product.
> Supersedes the original "AI for Business Interface" PRD (a chat‑first Electron broker with a
> Coordinator, document engine, and RBAC) — that direction was dropped. See git history for the
> archived vision.

## Problem Statement

Teams increasingly drive day‑to‑day engineering through CLI coding agents (Claude Code, OpenAI
Codex, GitHub Copilot CLI). Those agents are powerful but have no shared, durable sense of *what*
they're building toward: plans live in chat scrollback, external trackers, or a person's head.
Humans and agents drift out of sync, and the plan is never versioned next to the code it
describes. Teams need a lightweight way to plan and track agent work **in the repo**, readable
and writable by both an editor UI and the agents themselves.

## Solution

Octobots is a **VS Code extension** that turns a workspace's `.octobots/` directory into a
markdown project board — **campaigns → missions → tasks**, plus **bugs**. The files on disk are
the single source of truth (no database, no server), so the board is diffable and safe for
concurrent edits. The extension renders and edits the board, and ships a **workflow pack** that
teaches CLI agents to read and drive the same files.

## Object model

- **Campaign** — top‑level container for a body of work; composed of missions.
- **Mission** — a milestone‑sized initiative inside a campaign, id `M<n>`; composed of tasks.
  May also stand alone.
- **Task** — the unit of execution, id `T<missionN>.<taskN>`; carries ≥1 acceptance criterion.
- **Bug** — a defect attached to a campaign or mission, with a severity
  (`blocker | critical | major | minor | trivial`).

Each entity has a **status**: `draft → executing → awaitingApproval → done`, plus `failed` and
`cancelled`. Titles are `<id> - name` (a bare id is not a valid name).

## User stories

### Planning & editing (in VS Code)

1. As a user, I want to browse campaigns, missions, tasks, and bugs in a sidebar view, so I can
   see the whole plan at a glance.
2. As a user, I want to create a campaign, mission, task, or bug, so I can lay out work.
3. As a user, I want to open any entity in its own panel and edit its brief, so I can capture
   detail.
4. As a user, I want to set an entity's status from a dropdown, so progress is explicit.
5. As a user, I want to manage a task's acceptance‑criteria checklist, so "done" is verifiable.
6. As a user, I want to attach documents (links or files) to an entity, so context travels with
   the work.
7. As a user, I want to assign teams to entities, so ownership is clear.
8. As a user, I want to delete an entity, so I can prune abandoned work.

### Disk as the source of truth

9. As a user, I want every change written to markdown immediately, so the plan is always in the
   repo and reviewable via git.
10. As a user, I want edits made on disk (by an agent, or by `git checkout`/`stash`/`rebase`) to
    show up in the UI without churn or corruption, so the editor and the files never disagree.

### Driving the board from CLI agents

11. As a user, I want to install a workflow pack into my workspace, so my CLI agents understand
    the board model.
12. As an agent, I want small scripts to create and update board entities
    (`add-task.js`, `add-bug.js`, `set-status.js`, `set-criterion.js`, `add-doc.js`, …), so I can
    drive the board without a UI.
13. As an agent, I want a `validate.js` that flags malformed entities (missing acceptance
    criteria, bare‑id titles, missing sections), so I can keep the board well‑formed.
14. As an agent, I want a session primer that explains the board on start, so I follow the
    campaign/mission/task conventions automatically.

### Customizations

15. As a user, I want the extension to discover agent customizations (Claude Code, Copilot) in my
    workspace, so I can see what's configured.

## Implementation notes

- **No database, no server, no daemon.** `BoardHost` writes markdown and reconciles a fresh
  in‑memory model from disk; a single debounced, git‑quiescence‑gated watcher handles external
  edits. Light host state (team assignments, appearance) lives in VS Code `globalState`.
- **Monorepo:** `packages/board` (parse/validate/write), `packages/customizations` (discovery),
  `apps/vscode-extension` (host + React/Vite webview on VS Code theme tokens).
- **Workflow pack** (`resources/octobots-pack`): the `octobots` skill + command scripts, planning
  agents (`octobots-planner`, `octobots-orchestrator`), and a `hooks/primer.mjs` session hook,
  installed into `<workspace>/.claude` on demand.
- See `docs/tech-stack.md` for the full stack and `CLAUDE.md` for the architecture tour.

## Out of scope

- **Running or brokering agents.** Octobots is the board; it does not spawn, supervise, or proxy
  agents. CLI agents run themselves and drive the board through the pack scripts.
- **Chat UI / ACP transport / Coordinator orchestration.** Belonged to the retired vision.
- **Document engine, artifact versioning, RBAC/SSO, fleet provisioning.** Not built; git provides
  versioning and review for the markdown board.
- **Remote/web client.** The product is a local VS Code extension operating on the open workspace.
