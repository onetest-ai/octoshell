# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Octoshell is the **Octobots VS Code extension**: a markdown **board editor** for AI coding work.
A workspace's `.octobots/` directory holds **campaigns → missions → tasks** (plus **bugs** and
**workflows**), each
a human‑readable markdown file. There is **no database and no server** — the files on disk are the
single source of truth, which is what makes the board diffable and safe for multiple agents to edit
concurrently. The extension also installs an **Octobots workflow pack** (skill + planning agents +
a session hook) into a workspace so CLI coding agents (Claude Code, Codex, Copilot) can drive the
same board.

It is a **pnpm + turborepo** monorepo: one app (`apps/vscode-extension`) and two small libraries
(`packages/board`, `packages/tokenomics`).

> History: earlier revisions brokered chat to ACP agents across many backend packages (acp, domain,
> runtime, missions, taskbox, coordinator, scheduler, chat-ui) and a standalone Electron app
> (`apps/desktop`). All of that was **retired** in the board‑editor refactor — none of those
> packages or the desktop app exist anymore. Old specs/plans that mention them are historical.

## Commands

Run from the repo root (turborepo fans out to all packages, respecting build order):

```bash
pnpm build        # turbo run build  (tsc per package; esbuild + vite for the extension)
pnpm test         # turbo run test   (vitest; depends on ^build)
pnpm lint         # turbo run lint   (eslint)
pnpm typecheck    # turbo run typecheck
```

The extension is launched as an **Extension Development Host** (VS Code's *Run Octoshell Extension*
in `.vscode/launch.json`, i.e. F5) — not via a pnpm `dev` script.

Per‑package (faster while iterating):

```bash
pnpm --filter @octoshell/board test
pnpm --filter @octoshell/board test -- validate              # filter by test file/name substring
pnpm --filter @octoshell/vscode-extension typecheck
pnpm --filter @octoshell/vscode-extension lint
pnpm --filter @octoshell/vscode-extension build              # esbuild (host) + vite (webview) → dist/ + media/
pnpm --filter @octoshell/vscode-extension watch:host         # rebuild host on change (reload the dev host after)
pnpm --filter @octoshell/vscode-extension watch:webview      # rebuild webview bundle on change
```

**Important: changing a package's public types?** Downstream consumers read the built `dist/`, not
source. Run `pnpm --filter @octoshell/<pkg> build` (or `pnpm build`) before `typecheck`/`test` in
dependents, or they'll see stale `.d.ts`. Dependency order: `board`/`tokenomics` →
`vscode-extension`.

## Conventions

- **ESM + NodeNext**: TypeScript is `module: "NodeNext"`, `strict`, `noUncheckedIndexedAccess`.
  Relative imports **must** carry the `.js` extension (e.g. `import { x } from "./foo.js"`) even
  though the source is `.ts`. Match this in every new file.
- Packages export their public API through `src/index.ts`.
- Cross‑package imports use the package name (`@octoshell/board`), never relative paths into
  `../other-package/src`.

## Architecture

### Libraries (`packages/`)

- **`board`** — the file‑based board model. Pure functions over the `.octobots/` markdown tree, no
  I/O policy of its own beyond reading/writing files. `BoardModel` parses the tree into entities
  (a file's `octobots:id` managed block is authoritative — see `managed-block.ts`); `write.ts`
  creates/edits/deletes entities and writes status markers; `validate.ts` enforces the board rules
  (every task needs an acceptance criterion, id/name shape, etc.); `slug.ts` and `types.ts` round
  out the model. **Disk is authoritative**: reads are a pure rebuild, never a cascade‑mutate.
  `workflow-meta.ts` reads a workflow script's `export const meta` **without executing the script** —
  it brace‑matches the literal and evaluates only that, in an empty `node:vm` context — and
  `BoardModel` parses `workflows/` under every campaign and mission into `Workflow` entities.
- **`tokenomics`** — prices agent transcripts and rolls the cost up per mission and task.

### VS Code extension (`apps/vscode-extension`) — host + webview

Two sides, talking over the webview `postMessage` channel:

- **`src/host`** — the extension‑host (Node) side. `extension.ts` activates: opens the workspace
  folder, constructs a **`BoardHost`** (`board-host.ts`, the façade over `@octoshell/board` — every
  mutation writes markdown then reconciles a fresh `BoardModel` and emits `entities:changed`),
  registers the sidebar `TreeDataProvider` (`CampaignsTree`), the
  `EntityPanelManager` (one read‑mostly webview tab per campaign / mission / task / bug), and a
  single debounced, git‑quiescence‑gated `board-watcher` that re‑parses the whole `.octobots` tree
  after it settles. `rpc-dispatcher.ts` is the canonical RPC table — each webview `rpc` call routes
  to a `BoardHost` / `AppearanceStore` method.
  `octobots-skill.ts` / `octobots-hooks.ts` install the bundled `resources/octobots-pack` (skill +
  planning agents + session hook) into `<workspace>/.claude`.
- **`src/webview`** — a **single vite bundle** (React + Tailwind on CSS‑variable VS Code theme
  tokens; never hardcode colors — use tokens like `bg-list-active`, `text-fg-muted`).
  `chat-entry.tsx` is the entry (a legacy name — there is no chat); it routes on the host's `bind`
  message (`{kind, id}`) to `CampaignView`, `MissionView`, `TaskView`, `BugView`, or `WorkflowView` —
  the entity detail editors with status dropdowns, acceptance‑criteria checklists, and document links.
  `WorkflowView` pairs a read‑only `workflow-diagram.tsx` (hand‑rolled SVG, no layout library) with a
  structured step editor that round‑trips through `workflow:setMeta`. `rpc-client.ts` wraps `postMessage` as request/response (`rpc` → `rpc:result`);
  `octoshell-shim.ts` exposes the `window.octoshell` API the views consume.

The host↔webview protocol: host → webview posts `bind` (which entity this panel shows) and
`rpc:result`; webview → host posts `webview-ready` and `rpc`.

### Data flow for a board edit

A detail view's field change → `window.octoshell.*` RPC → webview posts `rpc` → host `dispatch`
→ `BoardHost` mutation writes the markdown file → `BoardHost` reconciles (rebuilds the `BoardModel`)
and emits `entities:changed` → host re‑binds/refreshes the affected webview panels and trees. The
external `board-watcher` catches edits made on disk outside the extension (including bulk git
operations) and triggers the same reconcile.

## The Octobots workflow pack

`apps/vscode-extension/resources/octobots-pack/` is shipped inside the extension and copied into a
target workspace's `.claude/` on demand (the *Octobots: Install Workflow Pack* command, or the
prompt on activation). It contains the `mission-planner` skill (board anatomy, planning rules, and
the `scripts/` that edit boards — named `octobots` before pack v19), the `workflow-designer` skill
(deciding how a planned mission runs — phases, agents, parallelism — and authoring `workflow.js`),
the `mission-execution` skill
(driving a planned task to a merged, verified PR), planning agents (`octobots-planner`,
`octobots-orchestrator`), and a `hooks/primer.mjs` session hook that teaches a CLI agent how to read
and drive the `.octobots/` board. `scripts/add-workflow.js`, `set-step.js` and `add-run.js` author
the workflows the app draws; `mission-execution` hands a mission's `workflow.js` to Claude Code's
`Workflow` tool — the extension never runs it. `installPack` deletes skill dirs retired by a rename, so an
upgraded workspace never ends up with two copies. This is product payload — keep it in sync with the board model in
`packages/board`.

## Testing

Vitest across the board. Renderer tests use happy‑dom + `@testing-library/react` (plus an
`attachInternals` polyfill for `@vscode-elements` web components in `test-setup.ts`). The `board`
and `tokenomics` packages test their pure functions directly against fixture trees; host‑side
tests write to temp directories rather than the repo's own `.octobots/`.
