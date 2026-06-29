# Octobots — Product Brief

## Overview

Octobots (codename **Octoshell**) is a VS Code extension that turns a workspace's
`.octobots/` directory into a living project board for AI coding work. Work is organized as
**campaigns → missions → tasks**, plus **bugs** — each stored as a plain‑markdown file. There
is **no database and no server**: the files on disk are the single source of truth, so the board
is diffable, code‑reviewable, and safe for multiple agents (and humans) to edit at the same time.

Alongside the editor, Octobots ships a **workflow pack** — a skill, planning agents, and a
session hook — that teaches CLI coding agents (Claude Code, OpenAI Codex, GitHub Copilot CLI)
how to read and drive the same board. The board is the shared contract between the human in the
editor and the agents on the command line.

## Who it's for

Engineers and AI‑assisted teams who drive day‑to‑day work through CLI coding agents and want a
lightweight, file‑based way to plan and track that work **without leaving the repo**:

- **Plan** a body of work as a campaign of missions and tasks, with acceptance criteria.
- **Track** progress as agents pick work up and mark it done — statuses live in the files.
- **Review** the plan and its history through normal git diffs and pull requests.

## Problem

CLI coding agents are powerful but stateless about *what* they're building toward. Plans live in
chat scrollback, external trackers, or a human's head; agents and humans drift out of sync; and
nothing about the plan is versioned alongside the code. Octobots closes that gap by making the
plan a first‑class, in‑repo, markdown artifact that both the editor UI and the agents operate on.

## How it works

- **In the editor.** The Octobots activity‑bar view lists campaigns, missions, tasks, and bugs.
  Opening any entity gives a detail panel with a status dropdown, an acceptance‑criteria
  checklist, attached documents, and team assignments. Every change is written straight to
  markdown; the board is rebuilt from disk and a debounced, git‑quiescence‑gated watcher keeps the
  UI honest through `git checkout` / `stash` / `rebase`.
- **For agents.** Installing the workflow pack drops the `octobots` skill, planning agents
  (`octobots-planner`, `octobots-orchestrator`), and a session‑primer hook into
  `<workspace>/.claude`. Agents create and update board entities through small scripts
  (`add-task.js`, `set-status.js`, `set-criterion.js`, `validate.js`, …) and the same files the
  editor renders.

## Organizing primitives

- **Campaign** — a long‑running body of work; the top‑level container, composed of missions.
- **Mission** — a milestone‑sized initiative inside a campaign (`M<n>`), composed of tasks.
- **Task** — the unit of execution (`T<missionN>.<taskN>`). Every task carries at least one
  verifiable acceptance criterion.
- **Bug** — a defect attached to a campaign or a mission, with a severity.

Each entity has a **status** (`draft → executing → awaitingApproval → done`, plus `failed` /
`cancelled`) that agents keep current as work moves.

## What it is not

Octobots is intentionally small. It is **not** a chat client, an agent runtime, or an
orchestration bus — it does not run or broker agents itself. It is the shared, file‑based board
that an editor and external CLI agents both read and write.

> **History.** Earlier drafts of this project (see git history and retired specs) envisioned a
> chat‑first Electron desktop app that brokered ACP agents through a Coordinator, with a bundled
> document engine and role‑based provisioning. That direction was dropped; the shipped product is
> the focused, file‑based VS Code board editor described above.
