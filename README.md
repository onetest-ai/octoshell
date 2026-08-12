# Octoshell

> The **Octobots** VS Code extension — plan and track AI coding work as plain‑markdown
> boards, right inside the editor.

Octoshell is a VS Code extension that turns a folder's `.octobots/` directory into a
living project board: **campaigns → missions → tasks**, plus **bugs**, each stored as a
human‑readable markdown file. There is no database and no server — the files on disk are the
single source of truth, so the board is diffable, reviewable, and safe for multiple agents to
edit concurrently.

It also installs an **Octobots workflow pack** (a skill + planning agents + a session hook)
into a workspace, teaching CLI coding agents — Claude Code, OpenAI Codex, GitHub Copilot CLI —
how to read and drive the same board.

## octograph — the architecture map

Octobots ships `octograph`, which mines your git history for **which files actually change
together** — the coupling no import edge explains. Two commands from the Command Palette,
no install step, no LLM, no server.

See [docs/octograph.md](docs/octograph.md).

## Features

- **Board editor in the sidebar** — browse and edit campaigns, missions, tasks, and bugs from
  the Octobots activity‑bar view; open any entity in its own editor tab.
- **Status and acceptance criteria** — set statuses from dropdowns, manage a task's
  acceptance‑criteria checklist, and attach documents.
- **Workflows** — plan *how* the work runs, not just what it is. A workflow is a folder holding a
  `workflow.md` brief and a `workflow.js` Claude Code dynamic‑workflow script; the extension draws its
  phases, agents and parallel branches as a diagram and lets you edit the steps, while Claude Code
  runs the script. A campaign's workflows orchestrate its missions; a mission's single workflow
  orchestrates its tasks.
- **Disk is authoritative** — every change is written to markdown and the board is rebuilt from
  disk; a single debounced, git‑quiescence‑gated watcher keeps the UI in sync through
  `git checkout` / `stash` / `rebase` without churn.
- **Workflow pack installer** — one click drops the Octobots skill and planning agents into
  `<workspace>/.claude` so your CLI agents understand the board model.

## Repository layout

This is a **pnpm + turborepo** monorepo.

| Path | What it is |
| --- | --- |
| `apps/vscode-extension` | The VS Code extension (host + React webview), the only app. |
| `packages/board` | File‑based library: parse, validate, and write the markdown board model. No DB. |
| `docs/` | Product brief, PRD, and tech‑stack notes. |

## Getting started

**Requirements:** Node ≥ 22.5 (see `.nvmrc`) and pnpm 9.

```bash
pnpm install
pnpm build        # turbo: tsc per package + esbuild/vite for the extension
pnpm test         # turbo: vitest
```

**Run the extension:** open the repo in VS Code and press **F5** (the *Run Octoshell Extension*
launch config) to start an Extension Development Host. Open a folder in that host and use the
**Octobots** view in the activity bar.

Other useful commands:

```bash
pnpm lint
pnpm typecheck
pnpm --filter @octoshell/board test          # one package
pnpm --filter @octoshell/vscode-extension build
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build/test conventions and the development workflow.
Architecture and code conventions for contributors (and AI agents) live in [CLAUDE.md](CLAUDE.md).

## License

[Apache-2.0](LICENSE) © OneTest AI
