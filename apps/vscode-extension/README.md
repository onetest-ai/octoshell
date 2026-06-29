# Octobots

Plan and track AI coding work as plain‑markdown boards — **campaigns → missions → tasks**, plus
**bugs** — right inside VS Code. Octobots turns a workspace's `.octobots/` directory into a living
project board with **no database and no server**: the markdown files on disk are the single source
of truth, so your plan is diffable, reviewable in pull requests, and safe for multiple agents (and
humans) to edit at the same time.

It also installs a **workflow pack** that teaches CLI coding agents — Claude Code, OpenAI Codex,
GitHub Copilot CLI — how to read and drive the very same board.

## Features

- **Board editor in the sidebar.** Browse campaigns, missions, tasks, and bugs from the Octobots
  activity‑bar view; open any item in its own editor tab.
- **Status, acceptance criteria, teams, and docs.** Set statuses from dropdowns, manage a task's
  acceptance‑criteria checklist, attach documents, and assign teams.
- **Disk is authoritative.** Every change is written to markdown and the board is rebuilt from
  disk. A single debounced, git‑aware watcher keeps the UI in sync through
  `git checkout` / `stash` / `rebase` without churn.
- **Customizations browser.** Discovers agent customizations (Claude Code, GitHub Copilot) present
  in your workspace.
- **Workflow pack installer.** One command drops the Octobots skill and planning agents into
  `<workspace>/.claude` so your CLI agents understand the board model.

## Getting started

1. Install the extension and **open a folder** (Octobots operates on the open workspace folder).
2. Open the **Octobots** view from the activity bar.
3. Create a **campaign**, then add **missions** and **tasks** under it. Every task gets at least
   one acceptance criterion.
4. *(Optional)* Run **“Octobots: Install Workflow Pack”** from the Command Palette to let your CLI
   coding agents drive the board too.

## How the board is organized

| Entity | What it is | Id |
| --- | --- | --- |
| **Campaign** | Top‑level body of work; contains missions. | — |
| **Mission** | A milestone‑sized initiative; contains tasks. | `M<n>` |
| **Task** | The unit of execution; carries ≥1 acceptance criterion. | `T<missionN>.<taskN>` |
| **Bug** | A defect attached to a campaign or mission, with a severity. | — |

Each item has a **status**: `draft → executing → awaitingApproval → done`, plus `failed` and
`cancelled`. The board lives as markdown under `.octobots/`, so it travels with your repo and shows
up in normal git diffs.

## Commands

- **Octobots: New Campaign**
- **Octobots: New Mission in this Campaign**
- **Octobots: Install Workflow Pack**
- **Octobots: Add Customization**
- … plus per‑item status and delete actions in the tree context menus.

## Requirements

- VS Code 1.122.0 or newer.
- A workspace folder open in VS Code.

## License

[Apache‑2.0](https://github.com/onetest-ai/octoshell/blob/main/LICENSE) © OneTest AI.
Source: [github.com/onetest-ai/octoshell](https://github.com/onetest-ai/octoshell).
