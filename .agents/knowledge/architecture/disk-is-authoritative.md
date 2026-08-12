---
name: Disk is authoritative — reads are a pure rebuild, never a cascade-mutate
description: The board model has no in-memory state that mutations patch; every write rebuilds BoardModel from disk from scratch, which is why the write→reconcile pattern and board-watcher exist.
type: reference
applies_to: [js-dev, tech-lead, qa-engineer, scout]
verified: 2026-08-09
aliases: [disk authoritative, pure rebuild, no cascade-mutate]
tags: [area/board]
---

## The fact

There is no in-memory board state that mutations incrementally patch. Every write
(`packages/board/src/write.ts`) is: write markdown/YAML to disk first, then rebuild a fresh
`BoardModel` by re-parsing the `.octobots/` tree from scratch. The extension host's `BoardHost`
façade follows the same pattern: mutate → reconcile (full rebuild) → emit `entities:changed`.

The external `board-watcher` (debounced, git-quiescence-gated) exists *because* of this design —
it re-parses the whole tree after any external change (manual edit, `git checkout`, `stash`,
`rebase`) settles, rather than trying to diff and patch. There is deliberately no cascade-mutate
code path to keep in sync.

## Why it matters / what it costs to get wrong

- **`js-dev`** implementing a new mutation must write-then-rebuild, not patch an in-memory model —
  patching would silently diverge from what's actually on disk the next time the watcher fires.
- **`tech-lead`** reviewing a PR that adds any board mutation should flag anything that tries to
  update `BoardModel` state directly instead of going through write → reconcile.
- **`qa-engineer`** relies on this when reasoning about race conditions: two concurrent writers
  (extension + a CLI agent editing files directly) are safe specifically because neither holds
  authoritative in-memory state — disk always wins on the next rebuild.

## How this was verified

2026-08-09 — read `packages/board/src/write.ts` directly: four separate comments state disk/folder
authoritativeness (e.g. line 454, *"The entity FOLDER is authoritative for existence (BoardModel
derives entities from disk)"*). Cross-checked against the shipped `README.md` feature list
(*"Disk is authoritative — every change is written to markdown and the board is rebuilt from
disk"*) and `CLAUDE.md`'s own architecture section for `packages/board`, which states the same
rule in its own words.

Related: [[dual-schema-entity-io]] — the two schema implementations exist because *both* the
extension and the pack scripts read/write this same disk format independently, which only works
safely because disk, not either process's memory, is the source of truth.
