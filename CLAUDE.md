# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Octoshell is the **Octobots VS Code extension**: a markdown **board editor** for AI coding work.
A workspace's `.octobots/` directory holds **campaigns → missions → tasks** (plus **bugs**), each
a human‑readable markdown file. There is **no database and no server** — the files on disk are the
single source of truth, which is what makes the board diffable and safe for multiple agents to edit
concurrently. The extension also installs an **Octobots pack** (skills +
session hooks) into a workspace so CLI coding agents (Claude Code, Codex, Copilot) can drive the
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
  `octobots-skill.ts` / `octobots-hooks.ts` install the bundled `resources/octobots-pack`: skills
  and the graph payload under `<workspace>/.claude`, hook scripts into `.octobots/hooks`, and
  tokenomics into `.octobots/tokenomics`.
- **`src/webview`** — a **single vite bundle** (React + Tailwind on CSS‑variable VS Code theme
  tokens; never hardcode colors — use tokens like `bg-list-active`, `text-fg-muted`).
  `chat-entry.tsx` is the entry (a legacy name — there is no chat); it routes on the host's `bind`
  message (`{kind, id}`) to `CampaignView`, `MissionView`, `TaskView`, or `BugView` —
  the entity detail editors with status dropdowns, acceptance‑criteria checklists, and document links.
  `rpc-client.ts` wraps `postMessage` as request/response (`rpc` → `rpc:result`);
  `octoshell-shim.ts` exposes the `window.octoshell` API the views consume.

The host↔webview protocol: host → webview posts `bind` (which entity this panel shows) and
`rpc:result`; webview → host posts `webview-ready` and `rpc`.

### Data flow for a board edit

A detail view's field change → `window.octoshell.*` RPC → webview posts `rpc` → host `dispatch`
→ `BoardHost` mutation writes the markdown file → `BoardHost` reconciles (rebuilds the `BoardModel`)
and emits `entities:changed` → host re‑binds/refreshes the affected webview panels and trees. The
external `board-watcher` catches edits made on disk outside the extension (including bulk git
operations) and triggers the same reconcile.

## The Octobots pack

`apps/vscode-extension/resources/octobots-pack/` is shipped inside the extension and copied into a
target workspace on demand (the *Octobots: Install Octobots Pack* command, or the prompt on
activation). Skills, the graph payload and the hook registration go under `.claude/`; hook scripts
install to `.octobots/hooks` and tokenomics to `.octobots/tokenomics`. It contains five skills: `mission-planner` (board anatomy, planning rules, and
the `scripts/` that edit boards), `mission-execution` (driving a planned task to a merged, verified
PR), `mission-completion-gate` (the blocking mission-level gate), `knowledge-explorer` (reading what
the repo already knows, enriched by octograph when installed) and `octobots-doctor` (acting on pack
and board health findings, chiefly a pending pack reconcile). It also contains the session hooks
under `hooks/` (the session hooks `primer.mjs`, `work-log.mjs` and `mission-gate.mjs`, plus
`status-flip.mjs`, a helper module the last two import), the optional
`statusline/`, the `tokenomics/` scripts that collect and price transcripts at the mission gate, and
the bundled `graph/octograph.mjs`.

Missions are executed by **direct sub-agent dispatch**: `mission-execution` has the orchestrator
dispatch one sub-agent per phase through the `Agent` tool. There is no Workflow tool, no workflow
script, and no workflow entity in the board model; the extension never runs a mission (it does run `doctor.js` and the graph commands in a terminal). A leftover
`workflows/` folder is ignored by the board, and `validate.js` / `doctor.js` warn about it.

**Pack updates (reconcile).** The pack is versioned as one unit (`OCTOBOTS_PACK_VERSION`; see
`.agents/knowledge/architecture/pack-version-is-one-unit.md`). When `installPack` finds a SKILL.md the
workspace changed locally, the install prompt offers three choices: *reconcile* (the default),
*overwrite* (saves the local text as `overwritten-local.md` first) or *keep* (remembered while the
file is unchanged). Reconcile leaves the live skill alone and stages `base.md`, `local.md`,
`upstream.md` (only for a skill the pack still ships; a retired skill has none) and `RECONCILE.md` under `.octobots/pack-updates/v<N>/<skill>/`, recording it in
`.octobots/pack-updates/pending.json`. The session primer sees the pending record and tells the agent
to run the `octobots-doctor` skill, which merges the three versions and writes `merged.md` and
`DECISIONS.md`. The bases come from `resources/shipped-skills.json.br`, the store of every SKILL.md
the pack has shipped: any change to a pack SKILL.md is followed by
`node apps/vscode-extension/scripts/shipped-skills.mjs --write`, with the store committed.
`installPack` also deletes skill dirs retired by a rename, so an upgraded workspace never ends up
with two copies. This is product payload: keep it in sync with the board model in `packages/board`.

## Testing

Vitest across the board. Renderer tests use happy‑dom + `@testing-library/react` (plus an
`attachInternals` polyfill for `@vscode-elements` web components in `test-setup.ts`). The `board`
and `tokenomics` packages test their pure functions directly against fixture trees; host‑side
tests write to temp directories rather than the repo's own `.octobots/`.

## Agent-ops rules

How agents run commands here. The pack's `mission-execution` skill carries the same rules for every
project; they are restated because they are what an agent gets wrong without them.

- **Servers:** start one with `nohup ... > log 2>&1 < /dev/null &`, then poll readiness with a bounded
  `curl -m 2` loop (a fixed number of tries, each capped at 2 seconds). Never wait on a server
  unbounded.
- **No `timeout` on macOS.** Use the Bash tool's `timeout` parameter, or
  `perl -e 'alarm shift; exec @ARGV' N cmd`.
- **Never background a test command** (`pnpm test`, `vitest`, a coverage run). Run it in the foreground
  under a Bash timeout. Only non-terminating servers and watchers are backgrounded.
- **QA databases:** QA server, migration and seed commands run through `qa-env.mjs <db> -- <cmd...>`
  (config `.octobots/qa-env.json`), so they cannot touch a real database. Octoshell has no database,
  so nothing here needs it.
- **Plan review before build:** a mission moves to `executing` only after a `## Plan review (...)`
  record (`Reviewers: ba (...), tech-lead (...)` and `Verdict: approved` or `Verdict: approved with nits`) sits in its notes or its
  campaign's. `set-status.js` and the status dropdown refuse otherwise; the override is
  `--force=<reason>` or the dropdown's confirm.
- **Test lanes and parked tests:** the fast and coverage commands are declared in `AGENTS.md`
  § Test lanes. `node apps/vscode-extension/resources/octobots-pack/skill/mission-execution/scripts/scan-parked.js`
  must exit 0: a skipped, todo or xfailed test is a parked defect unless the user signs it off in
  `.octobots/parked-signoff.txt`.

<!-- BUNDLE:feature-development START -->
## Team roles on this project

This is a pure **TypeScript/Node** monorepo — no Python, no iOS, no Android code exists here (see
`AGENTS.md` § Team roles for how this was verified). Of the feature-development bundle's roles,
only `js-dev` (all app code here is TS), `qa-engineer`, `ba`, `tech-lead`, `project-manager`, and
`scout` have work. `python-dev`, `ios-dev`, `android-dev`, and `test-automation-engineer` (the
bundle's default Playwright-e2e role) have **no applicable surface** — there is no backend
service, no mobile app, and end-to-end coverage here is Vitest + happy-dom against the extension
itself, owned by `js-dev`/`qa-engineer`. Full per-role detail: `AGENTS.md` § Team roles.

## Agent memory — two layers

**`.agents/knowledge/`** — distilled, cross-role, **verified** facts about this project. Meant to
be committed and reviewed (see `AGENTS.md` § Agent memory for a `.gitignore` gap scout found here).
Read its `README.md` before starting, plus the folder covering what you are touching.

**`.agents/memory/<role>/`** — your own working notes and daily log. **Local only** (gitignored,
never shared between machines), so anything another role needs is invisible there.

Promote a fact to `.agents/knowledge/` only if it is cross-role, verified (dated, method stated),
durable, and costly to rediscover — see `AGENTS.md` § Agent memory for the full rule. Never commit
an unverified claim there; it is worse than silence, because it is trusted.
<!-- BUNDLE:feature-development END -->
