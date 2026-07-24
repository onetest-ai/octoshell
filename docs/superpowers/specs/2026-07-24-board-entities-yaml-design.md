# Board entities: Markdown → YAML — Design

**Date:** 2026-07-24
**Status:** Approved (design)
**Component:** `packages/board`, `apps/vscode-extension` (host + a little webview), the workflow pack.

## Problem

Board entities (`campaign.md` / `mission.md` / `task.md` / `bug.md`) are Markdown with `##` sections.
The parent's `## Tasks` / `## Bugs` sections are a **hand-edited projection** of folder-backed
children, and that projection is fragile: `add-task.js` assumes `## Tasks` is the last section, so on
a mission that already has a `## Bugs` section it drops placeholders greedily and appends the task
line at end-of-file — **under `## Bugs`**. Reproduced:

```
## Tasks
## Bugs
- A crash bug
- T1.1 - Real task     ← task projected as a bug; ## Tasks left empty
```

The folder (`tasks/t1-1-real-task/`) is correct (disk is authoritative), but the projection and any
`[status:]`/`[role:]` markers on that line are wrong. This is a *class* of bug: any script that
inserts a line into a positional Markdown section can get it wrong.

## Decision

Move every entity file from Markdown to **YAML** with a defined schema, and **stop projecting
children into the parent** — children are discovered by folder scan, and their `status`/`role`/
`severity` live in the child's own file. With no hand-edited projection, the misplacement bug is
**structurally impossible**.

`workflow.js` + `runs.jsonl` are unchanged (already structured).

## Model (the crux)

- Each entity folder holds **one structured file**: `campaign.yaml`, `mission.yaml`, `task.yaml`,
  `bug.yaml`. It carries **only that entity's own fields** — it does **not** enumerate its children.
- Tasks and bugs remain folder-backed; the app derives the child list by scanning `tasks/` / `bugs/`.
- `status`, `role`, `severity` are **fields in the child's YAML**, not markers on a parent line.
- The Markdown "managed header + agent-owned tail" split disappears — it existed to protect Markdown
  from hand-editing; YAML fields don't need it.

## Schema (one shape per kind)

```yaml
# task.yaml
name: T1.1 - Add JWT validation
status: draft            # draft | active | done | failed | cancelled
role: python-dev         # optional
description: |
  Free prose, multi-line.
acceptance_criteria:
  - text: JWT validated on /login
    done: false
documents:
  - label: spec
    target: docs/spec.md
tokenomics:              # optional
  effort_days: 1
  size_tshirt: S
  complexity_score: 11
```

- **campaign.yaml**: `name`, `description`, `acceptance_criteria[]`, `status` (settable; overrides the
  mission rollup when non-draft), `target`, `documents[]`.
- **mission.yaml**: `name`, `description`, `acceptance_criteria[]`, `documents[]`, `tokenomics?`.
  (Mission status is still driven by the app run lifecycle + task rollup; see mission-status doctrine.)
- **task.yaml**: `name`, `description`, `acceptance_criteria[]`, `status`, `role?`, `tokenomics?`.
- **bug.yaml**: `name`, `severity`, `status`, `description`, `steps_to_reproduce`, `expected`,
  `actual`, `rca`, `environment`.
- `acceptance_criteria`: list of `{ text, done }`. `documents`: list of `{ label, target }`.

## Format handling — YAML with zero external install in scripts

- **Board package** (`packages/board`): depends on `js-yaml`.
- **Pack scripts** (dependency-free standalone Node): **vendor a bundled `js-yaml`** (a single ESM
  file) into `scripts/`, imported directly. Real, battle-tested parser; no hand-rolled YAML; still
  zero external install in any target workspace. `add-task.js`/`add-bug.js` become "create folder +
  write child YAML" — **no parent edit at all**. `set-status`/`set-criterion`/`set-role` edit the
  **child's** YAML.

## Migration (automatic + safe)

Rewriting every entity file in a real user board is the dangerous part.

- **App path**: on activation, `BoardHost` sweeps every entity folder — parse the `.md` managed-block
  → fields → write `.yaml`, fold the parent's `[status:]`/`[role:]`/`[severity:]` markers into the
  children's YAML, then retire the `.md`. **Idempotent**; safe every launch.
- **CLI-first boards**: a standalone `migrate.js` in the pack (also runnable from the primer hook),
  so a board driven by scripts before the app opens still converts.
- **Dual-read overlap**: both the board parser and the scripts read a `.md` when a folder has no
  `.yaml` yet, so nothing breaks mid-migration.
- **Reversible-ish**: write and re-read the `.yaml` before removing the `.md`, and **trash** (not
  hard-delete) the `.md`.

Discovery keys on `<kind>.yaml` (with the one-version `.md` fallback).

## Blast radius → a mission (~8 tasks)

1. **board: schema + serializer** — new `entity-schema.ts` (YAML load/dump + typed fields) replacing
   `managed-block.ts`; the `ManagedFields` shape becomes the entity schema.
2. **board: parse** — `BoardModel` discovers by `<kind>.yaml`, reads fields from YAML, derives child
   lists from folders, reads child `status`/`role`/`severity` from the child file.
3. **board: write + validate** — `write.ts` create/update write YAML fields; `add-task`/`add-bug`
   equivalents stop touching the parent; `validate.ts` schema-validates.
4. **pack scripts** — vendor js-yaml; rewrite `add-*`, `set-*`, `list`, `show`, `validate`,
   `add-doc` to YAML; `add-task`/`add-bug` create folder + child YAML only.
5. **app** — RPC write handlers write YAML fields (the field-based RPC contract is largely unchanged,
   so the webview panels are mostly untouched); the delete/status flows.
6. **migration** — `migrateEntitiesToYaml(root)` in the board package + `BoardHost` call on
   activation + standalone `migrate.js`; dual-read; trash-not-delete.
7. **docs** — primer + all SKILL.md (board anatomy, schema, scripts) rewritten for YAML; pack version
   bump.
8. **end-to-end QA** — the misplacement bug is gone; a full board round-trips md→yaml with no lost
   status/role/criteria; dual-read + idempotent migration verified.

## Non-goals / accepted changes

- **Identity shift.** The product becomes a *YAML* board editor rather than a *Markdown* one. The
  panels are unchanged, but the README/positioning shift — a conscious yes.
- `workflow.js` + `runs.jsonl` are out of scope (already structured).
- The webview's rendered UX does not change; only the on-disk format and the write/read layer do.
