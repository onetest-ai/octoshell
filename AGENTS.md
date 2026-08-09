# AGENTS

Full team reference for Octoshell. `CLAUDE.md` (auto-loaded every session) covers the
what/why/architecture in depth — read that first. This file adds what `CLAUDE.md` deliberately
leaves out: which team roles have work here, testing/CI detail, and the shared knowledge-layer
contract.

## Tech stack (verified 2026-08-09)

- **Language/runtime:** TypeScript 5.5.4, Node `>=22.5`, ESM throughout (`module: "NodeNext"`).
- **Monorepo:** pnpm 9.7.0 workspaces (`apps/*`, `packages/*`) + turborepo 2.0.6.
- **Extension host:** VS Code extension API, bundled with esbuild 0.23.
- **Webview UI:** React 18.3.1 + Tailwind 3.4.7, bundled with Vite 5.3.5; `zod` ^4 for the RPC
  payload shapes.
- **Board model:** hand-written, `js-yaml` for parsing — no ORM, no database.
- **Tests:** Vitest 2.0.5 everywhere; webview tests add happy-dom 15 + `@testing-library/react` 16.
- **Lint/types:** ESLint 9 + typescript-eslint 8, `tsc --noEmit` per package.
- **No backend service, no database, no server of any kind.** The `.octobots/` markdown tree on
  disk is the only persistence layer (see `CLAUDE.md` — "Disk is authoritative").
- **No Python, no iOS/Swift, no Android/Kotlin anywhere in the tree.** Confirmed by direct search
  (`find . -name "*.py" -o -name "*.swift" -o -name "*.kt" -o -iname "Podfile" -o -iname
  "build.gradle*"`, excluding `node_modules`/`.claude`/`.git`) on 2026-08-09: zero matches. This is
  a pure TypeScript/Node repository.

## Repository structure

```
apps/vscode-extension/
├── src/host/        ← extension-host (Node): BoardHost, TreeDataProvider, EntityPanelManager,
│                       board-watcher, rpc-dispatcher, octobots-skill/hooks installer
├── src/webview/      ← single Vite bundle (React + Tailwind): CampaignView/MissionView/TaskView/
│                       BugView/WorkflowView, rpc-client, octoshell-shim
├── src/protocol/     ← shared host↔webview message types
└── resources/octobots-pack/  ← shipped payload copied into a target workspace's `.claude/`
    └── skill/mission-planner/scripts/entity-io.mjs   ← see "Dual schema" below

packages/board/        ← @octoshell/board — pure functions over the .octobots/ tree
├── src/entity-schema.ts, write.ts, validate.ts, slug.ts, types.ts, workflow-meta.ts
└── test/

packages/tokenomics/    ← @octoshell/tokenomics — prices agent transcripts, rolls up cost
├── src/
└── test/

.octobots/              ← THIS repo's own work board (dogfooded) — do not treat as a fixture
docs/superpowers/       ← design specs (gitignored — see "Known repo gaps" below)
```

## Build, run, test

Exact commands are in `CLAUDE.md` § Commands — this file doesn't repeat them. Two things worth
adding here:

- **CI** (`.github/workflows/ci.yml`) runs, in order: `pnpm install --frozen-lockfile` → `pnpm
  lint` → `pnpm build` → `pnpm typecheck` → `pnpm test`. **Build before typecheck/test is load-
  bearing, not incidental** — see "Dist-before-typecheck" below.
- **Coverage:** `pnpm coverage` runs two separate gates — `coverage:board` (`vitest run
  --coverage` inside `packages/board`) and `coverage:pack` (`c8` over
  `resources/octobots-pack/skill/mission-planner/scripts/**`, thresholds 90% statements/lines/
  functions, 70% branches). The pack script coverage is measured **separately from** `packages/
  board`'s own coverage even though the two implement the same schema — see "Dual schema" below.

## Conventions

Detected conventions (naming, `.js`-extension imports, package-name cross-imports) are already
documented in `CLAUDE.md` § Conventions — treat that as authoritative, not this file.

## Team roles — what applies here

The installed feature-development bundle assumes a project may need a JS/TS frontend, a Python
(FastAPI/FastMCP) backend, an iOS app, and/or an Android app. **This project needs exactly one of
those: the JS/TS side.** There is no backend process of any kind (no HTTP server, no FastAPI, no
database) — "frontend" and "backend" isn't even the right split here; it's an extension host
process and a webview UI, both TypeScript, both owned by the same role.

| Role | Applicable? | Why |
|---|---|---|
| `js-dev` | **Yes — the only application-code role.** | Owns `apps/vscode-extension` (host + webview) and both `packages/`. All source in this repo is TypeScript. |
| `qa-engineer` | **Yes**, scoped narrowly | Verification here is Vitest (host/webview/board/tokenomics) plus manual runs through the Extension Development Host (F5) — there is no running web app or HTTP API to drive with a browser. |
| `ba` | **Yes** | Requirements/spec review — e.g. the in-flight `docs/superpowers/specs/2026-08-09-octograph-design.md`. |
| `tech-lead` | **Yes** | Architecture decisions and PR review across the dual-schema and dist/build hazards below. |
| `project-manager` | **Yes** | Routing and merge gate. |
| `scout` | **Yes** (this role) | Onboarding, kept current as the stack evolves. |
| `python-dev` | **No.** | Zero `.py` files outside `node_modules`/tooling caches — verified 2026-08-09. This role's existing memory briefing (`.agents/memory/python-dev/project_briefing.md`) describes a FastAPI/FastMCP stack overlay that has no target here; it was left in place unedited (scout doesn't delete another role's memory) but should not be treated as project-accurate. |
| `ios-dev` | **No.** | No `.swift`, no `.xcodeproj`/`Podfile` — not installed as an agent either. Octoshell is a VS Code extension, not a mobile app. |
| `android-dev` | **No.** | No `.kt`, no `build.gradle*` — not installed as an agent either. Same reason as iOS. |
| `test-automation-engineer` | **No** — not installed, and the role wouldn't map cleanly if it were. | Its bundle scope is Playwright browser/HTTP e2e "through the real stack" — there is no running web app or API surface to drive that way. E2E-equivalent coverage here is Vitest exercising the extension host and webview directly, which is `js-dev`/`qa-engineer` territory. `project-manager`'s routing table (`project-manager/AGENT.md`) lists a `test-automation` → `qa → test-automation-engineer → qa` pipeline for TMS-case automation; that pipeline has no destination on this project — route automation-shaped requests to `js-dev` (Vitest) instead. |

## Testing

- **Framework:** Vitest 2.0.5 monorepo-wide, `dependsOn: ["^build"]` in `turbo.json` — a package's
  tests run against its own **and its dependencies'** built output, not live TS.
- **`packages/board`** (21 test files) and **`packages/tokenomics`** (5 test files) test pure
  functions directly against fixture trees — no I/O beyond temp directories.
- **`apps/vscode-extension`** (27 test files) covers host-side logic against temp directories
  (never the repo's own `.octobots/`) and webview components via happy-dom +
  `@testing-library/react`, with an `attachInternals` polyfill in `test-setup.ts` for
  `@vscode-elements` web components.
- **Coverage gates:** see "Build, run, test" above — two separate `c8`/`vitest --coverage` runs,
  because the pack scripts (`resources/octobots-pack/skill/mission-planner/scripts/`) are
  dependency-free `.mjs` and deliberately not part of the `@octoshell/board` build.
- No Playwright, no browser e2e harness in this repo — `qa-engineer` verifies through the
  Extension Development Host (F5) plus Vitest, not a browser automation tool.

## Two hazards every dev/reviewer should know before touching board code

Full detail, verification method, and date live in `.agents/knowledge/` (see below) — summarized
here because both are easy to violate by accident:

1. **Dual schema.** `packages/board/src/entity-schema.ts` and `apps/vscode-extension/resources/
   octobots-pack/skill/mission-planner/scripts/entity-io.mjs` implement the *same* on-disk YAML
   shape twice, on purpose (the pack script must stay dependency-free), with no import edge between
   them. A change to one that isn't mirrored in the other silently breaks round-tripping. Since
   pack v36 both carry an `extra` catch-all so *unmodelled* keys survive a write — but a field
   still has to be modelled in **both** files before pack scripts can see or edit it.
2. **Dist-before-typecheck.** `board`/`tokenomics` publish `dist/*.d.ts`; the extension (and each
   other) import the *built* output, not `src/`. Change a public type and don't rebuild first, and
   `typecheck`/`test` in the dependent package silently checks against the stale `.d.ts`.

## Agent memory — two layers

**`.agents/knowledge/`** — distilled, cross-role, **verified** facts about this project. Meant to
be committed and reviewed. Read its `README.md` before starting, plus the folder covering what
you're touching. **Known gap (found 2026-08-09):** the repo's `.gitignore` line 14 is a bare
`.agents/`, which blanket-ignores this entire directory — knowledge notes, profile, memory, all of
it. `git add`/`git add -A` silently skips everything here, same failure mode already logged in
scout's memory for `docs/superpowers/specs/`. Until the `.gitignore` is scoped down (e.g.
`!.agents/knowledge/`), use `git add -f` for anything under `.agents/` you want committed. Not
fixed by scout in this pass — it's a `.gitignore` policy call left for the engineer.

**`.agents/memory/<role>/`** — your own working notes and daily log. Local only (gitignored by the
same line — correctly, this layer is *meant* to stay untracked), so anything another role needs is
invisible there.

Promote a fact to `.agents/knowledge/` only if it is cross-role, verified (dated, method stated),
durable, and costly to rediscover. Never commit an unverified claim there — it is worse than
silence, because it is trusted. Use the `memory` skill for the per-role layer and
`knowledge-curation` for the shared one.

## In-flight design work

`docs/superpowers/specs/2026-08-09-octograph-design.md` — a new, separate CLI (`octograph`) that
reconstructs architecture from git co-change history and joins it to the Octobots board; bridged
into this extension via two new commands in a planned `src/host/octograph.ts` /
`octograph-command.ts`. Status: draft design, not yet built. `ba` reviews it next for scope/
ambiguity/testable acceptance criteria; `tech-lead` reviews the implementation plan derived from
it. The spec itself documents the dual-schema hazard above (it's decision D7/the "Boundary that
must not be crossed" section) and cites it as a case its own `drift` command should be able to
detect once built.

<!-- BUNDLE:feature-development START -->
## Bundle-installed role conventions (feature-development)

The installed feature-development bundle ships generic multi-stack conventions in `CLAUDE.md`
under this same marker — trimmed there to what applies. The two universally-applicable pieces
(team roles, agent memory) are written out in full above rather than duplicated here. The bundle's
per-stack sections (Web/iOS/Android, "Definition of done") do not apply to this project per
"Team roles" above and were removed from both files rather than kept as dead text — if the bundle
installer re-runs an `--update` and re-appends them, re-apply this same trim; do not re-adopt the
iOS/Android/FastAPI content as project-accurate.
<!-- BUNDLE:feature-development END -->
