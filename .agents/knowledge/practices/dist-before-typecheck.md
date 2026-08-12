---
name: Rebuild a package before typecheck/test in its dependents
description: apps/vscode-extension imports the built dist/ of packages/board and packages/tokenomics, not their src/ — a per-package typecheck run outside turbo's dependency graph can silently check against a stale build.
type: reference
applies_to: [js-dev, tech-lead, qa-engineer]
verified: 2026-08-09
aliases: [dist rebuild, stale dist, build before typecheck]
tags: [area/build, area/tooling]
---

## The fact

`packages/board` and `packages/tokenomics` are consumed by `apps/vscode-extension` (and
`tokenomics` consumes `board`) via their **built** `dist/*.d.ts` and `dist/*.js`, not `src/`.
There is no path-mapped TS project reference resolving straight to source — package resolution
goes through each package's `exports` field, which points at `dist/`.

`turbo run typecheck` and `turbo run test` both declare `dependsOn: ["^build"]` in `turbo.json`,
so running them through `pnpm typecheck` / `pnpm test` at the repo root is safe — turborepo builds
dependencies first automatically. **The failure mode is specifically when a dev runs a
per-package command directly** (e.g. `pnpm --filter @octoshell/vscode-extension typecheck`, one of
the "faster while iterating" commands `CLAUDE.md` itself documents) after editing
`packages/board/src/*.ts` without an intervening build — turbo's dependency graph isn't invoked at
all in that case, so the extension typechecks against a stale `dist/*.d.ts` that doesn't reflect
the source edit. The check can pass or fail for the wrong reason.

## Why it matters / what it costs to get wrong

- **`js-dev`** changing a public type/export in `packages/board` or `packages/tokenomics` must run
  `pnpm --filter @octoshell/<pkg> build` (or plain `pnpm build`) before trusting a per-package
  `typecheck`/`test` run in a dependent — otherwise a real type error can go unreported, or a
  fixed one can appear to still fail.
- **`qa-engineer` / `tech-lead`** should treat a green per-package typecheck as inconclusive if the
  PR touched `packages/board/src` or `packages/tokenomics/src` in the same session without a
  visible rebuild step — ask for `pnpm build` first, or just re-run the root-level `pnpm
  typecheck` (safe by construction via `^build`).

## How this was verified

2026-08-09 — read `packages/board/package.json` and `packages/tokenomics/package.json` directly
(both declare `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`, and
`exports["."].types` → `./dist/index.d.ts`); read `turbo.json` (`"typecheck": { "dependsOn":
["^build"] }`, `"test": { "dependsOn": ["^build"] }`); read `.github/workflows/ci.yml` and
confirmed its step order is install → lint → **build** → typecheck → test. `CLAUDE.md` already
states the rule in its own words ("Downstream consumers read the built `dist/`, not source") —
this note adds the mechanism (turbo's `^build` dependency, and exactly which command path bypasses
it) rather than just restating the rule.

Related: [[dual-schema-entity-io]] — a different but adjacent hazard: that one is about two files
never being typechecked against each other at all (no import edge), this one is about one file
being typechecked against a stale build of another.
