---
name: The board YAML schema is implemented twice with no import edge — both copies must change together
description: entity-schema.ts and entity-io.mjs mirror the same on-disk entity format by comment only, not by code; a field unmodelled in both is invisible to the pack scripts even though the extra bag now stops it being destroyed.
type: reference
applies_to: [js-dev, tech-lead, ba]
verified: 2026-08-09
aliases: [dual schema, entity-schema, entity-io, mirrored implementations]
tags: [area/board, area/pack]
---

## The fact

Two files implement the *same* on-disk YAML entity schema independently, **by design, with no
import edge and none possible**:

- `packages/board/src/entity-schema.ts` — `KIND_KEYS`, a `KNOWN_KEYS`-equivalent, and an `extra:
  Record<string, unknown>` field on `EntityFields` (lines ~29–58).
- `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs` —
  its own `KIND_KEYS` (lines ~59–65) and `KNOWN_KEYS` (lines ~47–63), with its own `extra`
  round-trip (`carryForward`, lines 154/195), and a header comment: *"Mirrors
  packages/board/src/entity-schema.ts ... so the scripts and the app agree byte-for-byte."*

`entity-io.mjs` is deliberately dependency-free — the pack ships into a target workspace's
`.claude/` with zero install step, so it **cannot** `import` from `@octoshell/board`. The coupling
between the two files exists only as a comment; nothing enforces it mechanically.

**Since pack v36** (`packages/board` — commits `62a5369`/`bb35884`, "stop silent field loss on
every entity write"), both sides carry an `extra` catch-all so a key **neither file knows about**
survives a round-trip untouched instead of being dropped on the next write. That fixed the
"unknown key gets silently deleted" failure mode. It did **not** remove the dual-schema hazard: a
field that's supposed to be *addressable* — read, validated, or edited by the pack's own scripts
(`add-workflow.js`, `set-step.js`, `add-run.js`, etc.) — still has to be modelled explicitly in
**both** `KIND_KEYS`/field lists before those scripts can see or manipulate it by name. `extra`
only guarantees the field isn't destroyed; it doesn't make it usable on the pack side.

## Why it matters / what it costs to get wrong

Breaking this pair (editing one without the other) previously destroyed a campaign's `notes`
decision record in production — per the `extra` field's own doc comment in `entity-schema.ts`
("which is how a campaign's notes decision record was lost"), and per
`docs/superpowers/specs/2026-08-09-octograph-design.md`'s account of the same incident, dated
2026-07-27 there, cited as the motivating case for a planned `drift`-detection tool.

- **`js-dev`** changing `EntityFields`/`KIND_KEYS` in `entity-schema.ts` must mirror the change in
  `entity-io.mjs`'s `KIND_KEYS`/`KNOWN_KEYS` in the same PR — there is no compiler or test today
  that catches drift between them automatically.
- **`tech-lead`** reviewing any PR touching `packages/board/src/entity-schema.ts` should check for
  the matching `entity-io.mjs` edit before approving; its absence is a defect, not a style nit.
- **`ba`** should read the octograph design's own framing of this pair (its `drift` command's
  flagship example, and a Follow-up item: "External-tracker link field ... needs modeling in
  both") when scoping that spec — it's the concrete case the design's "hidden coupling" feature
  exists to catch.

## How this was verified

2026-08-09 — read both files directly and diffed their `KIND_KEYS` tables, which are textually
identical (campaign/mission/task/bug → the same key lists in the same order) — confirming the
header comment's claim rather than just trusting it. Confirmed the pack-v36 `extra` mechanism by
grepping `extra` in both files (`entity-schema.ts` lines 19/25/53/64/179/219;
`entity-io.mjs` lines 47/154/195) and reading the surrounding `carryForward`/round-trip code.
Confirmed the v36 commit history and incident framing via `git log --oneline` (`62a5369`,
`bb35884`) and the octograph design doc.

Related: [[disk-is-authoritative]] — this pair only works at all because neither side holds
authoritative in-memory state; each independently re-derives from the same on-disk files.
