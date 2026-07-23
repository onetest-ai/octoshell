# Octobots — Technical Stack

## Overview

Octobots is a **VS Code extension** built as a **pnpm + turborepo** monorepo. It is a
file‑based markdown board editor: no database, no server, no background daemon. The `.octobots/`
markdown tree on disk is the single source of truth; the extension reads, validates, and writes
it, and rebuilds its in‑memory model from disk on every change.

## Monorepo layout

| Package | Role |
| --- | --- |
| `apps/vscode-extension` | The VS Code extension — host (Node) side + React webview. The only app. |
| `packages/board` | Pure, file‑based board library: parse, validate, and write the markdown model. |

## Language & build

- **TypeScript**, `module: "NodeNext"`, `strict`, `noUncheckedIndexedAccess`. ESM throughout;
  relative imports carry the `.js` extension.
- **turborepo** orchestrates per‑package `build` / `test` / `lint` / `typecheck` in dependency
  order (`board`/`tokenomics` → `vscode-extension`).
- **Node ≥ 22.5** (see `.nvmrc`), **pnpm 9** (pinned via `packageManager`).
- Validation with **zod** where runtime schema checks are needed.

## Extension host (`apps/vscode-extension/src/host`)

- Bundled with **esbuild** (CommonJS, VS Code's `main`).
- `BoardHost` is the façade over `@octoshell/board`: every mutation writes markdown, then
  reconciles a fresh board model and emits `entities:changed`.
- A sidebar `TreeDataProvider` (`CampaignsTree`) and an `EntityPanelManager`
  that opens one webview tab per campaign / mission / task / bug.
- `rpc-dispatcher.ts` is the canonical RPC table routing webview calls to host services.
- A single **debounced, git‑quiescence‑gated** board watcher re‑parses the whole `.octobots`
  tree after it settles, so bulk git operations don't churn state.
- `octobots-skill` / `octobots-hooks` install the bundled workflow pack into `<workspace>/.claude`.
- Light host state (appearance) is kept in VS Code `globalState` — not a DB.

## Webview (`apps/vscode-extension/src/webview`)

- A single **Vite** bundle: **React 18** + **Tailwind** over **VS Code theme tokens** (CSS
  variables — never hardcoded colors), plus `@vscode-elements/elements` web components.
- The entry routes on the host's `bind` message to the entity detail editors (`CampaignView`,
  `MissionView`, `TaskView`, `BugView`) with status dropdowns, acceptance‑criteria checklists,
  document links, and team sections.
- Host↔webview communication is `postMessage` request/response (`rpc` → `rpc:result`).

## Board model (`packages/board`)

- `BoardModel` parses the `.octobots/` tree into typed entities. A file's `octobots:id` managed
  block is authoritative (`managed-block.ts`); `slug.ts` derives folder names.
- `write.ts` creates/edits/deletes entities and writes status markers to the board lines.
- `validate.ts` enforces board rules — e.g. every task/mission needs at least one checkable
  acceptance criterion, titles must be `<id> - name` (not a bare id), and required sections must
  be present.
- **Disk‑authoritative**: reads are a pure rebuild with additive id back‑fill, never a
  cascade‑mutate, which is what makes concurrent agent + human edits safe.

## The workflow pack (`resources/octobots-pack`)

Shipped inside the extension and copied into a workspace on demand:

- the **`octobots` skill** with command scripts (`add-task.js`, `add-bug.js`, `set-status.js`,
  `set-criterion.js`, `validate.js`, `list.js`, `show.js`, `add-doc.js`, `create-team.js`, …);
- **planning agents** (`octobots-planner`, `octobots-orchestrator`);
- a **session hook** (`hooks/primer.mjs`) that primes a CLI agent with the board model and is
  inert outside an `.octobots/` repo.

## Testing

- **Vitest** across all packages.
- `board` and `tokenomics` test pure functions against fixture trees.
- Webview tests use **happy‑dom** + `@testing-library/react` (with an `attachInternals` polyfill
  for the `@vscode-elements` web components).
- Host‑side tests write to temp directories rather than the repo's own `.octobots/`.

## Not in the stack (and why)

There is no Electron app, no ACP client, no Coordinator/supervisor/taskbox, no scheduler, no
SQLite, no document engine, and no RBAC/provisioning layer. Those belonged to an earlier,
abandoned "chat‑first broker" design (see git history and retired specs). The shipped product is
the focused, file‑based VS Code extension above.
