# Workflows Plan 1 — Remove Customizations and Teams

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Customizations feature and the Teams feature from the product, leaving the repo green, so that Workflows (plans 2 and 3) replace Teams cleanly.

**Architecture:** Pure deletion in dependency order — webview first (no consumers), then the RPC contract + dispatcher, then the host modules and the extension wiring, then the `packages/board` team helpers, then the whole `packages/customizations` package, then the pack's team doctrine. Each task ends with the full build/test/typecheck cycle green.

**Tech Stack:** pnpm + turborepo, TypeScript ESM (`NodeNext`), vitest, esbuild (host) + vite (webview), VS Code extension API.

## Global Constraints

- TypeScript is `module: "NodeNext"`, `strict`, `noUncheckedIndexedAccess`. Relative imports **must** carry the `.js` extension even though sources are `.ts`.
- Cross-package imports use the package name (`@octoshell/board`), never relative paths into another package's `src`.
- Downstream packages consume the built `dist/`, not source. After changing a package's public types, run `pnpm --filter @octoshell/<pkg> build` before `typecheck`/`test` in dependents. Dependency order: `board`/`customizations` → `vscode-extension`.
- Never hardcode colors in the webview — use the CSS-variable VS Code theme tokens (`bg-list-active`, `text-fg-muted`, …).
- UI icons are VS Code codicons, never emoji.
- Verification command for the whole repo, run from the repo root: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.

---

### Task 1: Remove the Team section from the webview

**Files:**
- Delete: `apps/vscode-extension/src/webview/team-section.tsx`
- Modify: `apps/vscode-extension/src/webview/campaign-view.tsx` (import at line 5, usage at line 278)
- Modify: `apps/vscode-extension/src/webview/mission-view.tsx` (import at line 5, usage at line 208)
- Modify: `apps/vscode-extension/src/webview/octoshell-shim.ts` (the `teams` block in the interface at line 36 and in the implementation at line 78, plus the `TeamBinding` type import at line 2)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `window.octoshell` no longer exposes a `teams` namespace; `CampaignView` and `MissionView` render without a Team section.

- [ ] **Step 1: Delete the component**

```bash
rm apps/vscode-extension/src/webview/team-section.tsx
```

- [ ] **Step 2: Remove its use in `campaign-view.tsx`**

Delete the import line:

```tsx
import { TeamSection } from "./team-section.js";
```

and delete the render line (currently line 278):

```tsx
      <TeamSection scope="campaign" scopeId={id} rpc={rpc} />
```

- [ ] **Step 3: Remove its use in `mission-view.tsx`**

Delete the import line:

```tsx
import { TeamSection } from "./team-section.js";
```

and delete the render line (currently line 208):

```tsx
      <TeamSection scope="mission" scopeId={id} rpc={rpc} campaignId={m?.campaignId} />
```

- [ ] **Step 4: Remove the `teams` namespace from `octoshell-shim.ts`**

Delete this block from the exported interface:

```ts
  teams: {
    list: () => Promise<TeamEntry[]>;
    setCampaignTeam: (campaignId: string, teamId: string | null) => Promise<unknown>;
    setMissionTeam: (missionId: string, teamId: string | null) => Promise<unknown>;
    getBinding: (scope: "campaign" | "mission", scopeId: string) => Promise<TeamBinding | null>;
    setBinding: (binding: TeamBinding) => Promise<{ ok: true }>;
  };
```

and this block from the implementation object:

```ts
    teams: {
      list: () => c("teams:list", {}) as never,
      setCampaignTeam: (campaignId, teamId) => c("campaign:setTeam", { campaignId, teamId }) as never,
      setMissionTeam: (missionId, teamId) => c("mission:setTeam", { missionId, teamId }) as never,
      getBinding: (scope, scopeId) => c("team:getBinding", { scope, scopeId }) as never,
      setBinding: (binding) => c("team:setBinding", { binding }) as never,
    },
```

Then remove `TeamBinding` (and `TeamEntry` if present) from the type import on line 2. If that leaves the import empty, delete the whole import statement.

- [ ] **Step 5: Verify the webview typechecks and builds**

Run: `pnpm --filter @octoshell/vscode-extension typecheck && pnpm --filter @octoshell/vscode-extension build`
Expected: both succeed with no output about `TeamSection`, `teams`, or `TeamBinding`.

- [ ] **Step 6: Run the extension tests**

Run: `pnpm --filter @octoshell/vscode-extension test`
Expected: PASS. If a renderer test asserts on the Team section, delete that test — the feature is gone, not broken.

- [ ] **Step 7: Commit**

```bash
git add -A apps/vscode-extension/src/webview
git commit -m "refactor(webview): remove the Team section"
```

---

### Task 2: Remove the Customizations UI surface from the extension

**Files:**
- Delete: `apps/vscode-extension/src/host/customizations-tree.ts`
- Delete: `apps/vscode-extension/src/host/customizations-io.ts`
- Delete: `apps/vscode-extension/test/customizations-io.test.ts`
- Delete: `apps/vscode-extension/test/customizations-tree.test.ts`
- Modify: `apps/vscode-extension/src/extension.ts` (imports at lines 5 and 10, construction at line 57, ctx field at line 62, tree at lines 129-135, view + command at lines 295-315)
- Modify: `apps/vscode-extension/package.json` (`octoshell.addCustomization` command, the `octoshell.customizations` view, the `view/title` menu entry referencing it)
- Modify: `apps/vscode-extension/src/webview/octoshell-shim.ts` (the `customizations` blocks at lines 30 and 72)

**Interfaces:**
- Consumes: Task 1's shim edits (same file — apply on top).
- Produces: the extension activates with a single `octoshell.campaigns` view; `DispatchCtx` no longer has a `customizationsIo` field (that field is removed in Task 3 — this task only removes its *construction site* once the dispatcher no longer needs it, so do Task 3 first if the compiler objects; the ordering below avoids that by removing the RPC in Task 3 and the ctx field here last).

- [ ] **Step 1: Remove the `customizations` namespace from `octoshell-shim.ts`**

Delete from the exported interface:

```ts
  customizations: {
    list: () => Promise<CustomizationItem[]>;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<unknown>;
    add: (input: unknown) => Promise<unknown>;
  };
```

and from the implementation object:

```ts
    customizations: {
      list: () => c("customizations:list", {}) as never,
      readFile: (path) => c("customizations:readFile", { path }) as never,
      writeFile: (path, content) => c("customizations:writeFile", { path, content }) as never,
      add: (input) => c("customizations:add", { input }) as never,
    },
```

Remove any now-unused `CustomizationItem` type import.

- [ ] **Step 2: Remove the view, command and tree from `extension.ts`**

Delete these imports:

```ts
import { CustomizationsIo } from "./host/customizations-io.js";
import { CustomizationsTree } from "./host/customizations-tree.js";
```

Delete the construction:

```ts
  const customizationsIo = new CustomizationsIo(fsPath);
```

Delete `customizationsIo,` from the `DispatchCtx` object literal.

Delete the tree construction and its explanatory comment block (currently lines 129-135):

```ts
  const tree = new CustomizationsTree(board, context.extensionPath);
```

Delete the view registration, its visibility handler, and the `octoshell.addCustomization` command registration (currently lines 295-315), including `customizationsView` from the `context.subscriptions.push(...)` list.

- [ ] **Step 3: Delete the host modules and their tests**

```bash
rm apps/vscode-extension/src/host/customizations-tree.ts \
   apps/vscode-extension/src/host/customizations-io.ts \
   apps/vscode-extension/test/customizations-io.test.ts \
   apps/vscode-extension/test/customizations-tree.test.ts
```

- [ ] **Step 4: Remove the manifest contributions**

In `apps/vscode-extension/package.json` delete the command entry:

```json
      {
        "command": "octoshell.addCustomization",
        "title": "Octobots: Add Customization",
        "icon": "$(add)"
      },
```

the view entry:

```json
        {
          "id": "octoshell.customizations",
          "name": "Customizations",
          "visibility": "collapsed"
        }
```

(and the trailing comma on the `octoshell.campaigns` entry that precedes it), and the `view/title` menu entry:

```json
        {
          "command": "octoshell.addCustomization",
          "when": "view == octoshell.customizations",
          "group": "navigation"
        },
```

- [ ] **Step 5: Verify — expect the dispatcher to still fail**

Run: `pnpm --filter @octoshell/vscode-extension typecheck`
Expected: FAIL, complaining that `customizationsIo` is missing from `DispatchCtx` in `rpc-dispatcher.ts`. That is exactly what Task 3 fixes. Do not patch it here.

- [ ] **Step 6: Commit the partial removal**

```bash
git add -A apps/vscode-extension
git commit -m "refactor(ext): remove the Customizations view, command and tree"
```

---

### Task 3: Remove the customizations and teams RPC surface

**Files:**
- Modify: `apps/vscode-extension/src/protocol/rpc-contract.ts` (the `TeamEntry`, `TeamBinding`, `TeamTypeAssignment` interfaces around lines 9-37; the `customizations` arg schemas at lines 102-106; the `teams` arg schemas at lines 176-183; the corresponding result-type entries)
- Modify: `apps/vscode-extension/src/host/rpc-dispatcher.ts` (imports at lines 2-3, `DispatchCtx` fields at lines 13-16, handlers at lines 56-59 and 101-108)
- Modify: `apps/vscode-extension/test/rpc-dispatcher.test.ts` (drop any customizations/teams cases)

**Interfaces:**
- Consumes: nothing.
- Produces: `RpcMethod` no longer includes `customizations:*`, `teams:list`, `campaign:setTeam`, `mission:setTeam`, `team:getBinding`, `team:setBinding`, `team:assign`, `team:assignments`. `DispatchCtx` loses its `teamAssignments` and `customizationsIo` fields.

- [ ] **Step 1: Remove the contract entries**

In `rpc-contract.ts` delete the `TeamEntry`, `TeamBinding` and `TeamTypeAssignment` interfaces, the `CustomizationItem` type import from `@octoshell/customizations`, the `// customizations` arg-schema block:

```ts
  "customizations:list": z.object({}),
  "customizations:readFile": z.object({ path: z.string() }),
  "customizations:writeFile": z.object({ path: z.string(), content: z.string() }),
  "customizations:add": z.object({ input: z.unknown() }),
```

the `// teams` arg-schema block (`teams:list`, `campaign:setTeam`, `mission:setTeam`, `team:getBinding`, `team:setBinding`, `team:assign`, `team:assignments`), and every matching entry in the result-type map further down the file.

- [ ] **Step 2: Remove the dispatcher handlers and ctx fields**

In `rpc-dispatcher.ts` delete these imports:

```ts
import type { TeamAssignments } from "./team-assignments.js";
import type { CustomizationsIo } from "./customizations-io.js";
```

delete these `DispatchCtx` fields with their doc comments:

```ts
  /** globalState-backed store for team-type assignments (board-backed, no database). */
  teamAssignments: TeamAssignments;
  /** Host-local customization file I/O (no daemon needed). */
  customizationsIo: CustomizationsIo;
```

and delete these handler entries:

```ts
  "customizations:list": (_a, c) => c.board.listCustomizations(),
  "customizations:readFile": (a, c) => c.customizationsIo.readCustomizationFile(a.path),
  "customizations:writeFile": (a, c) => c.customizationsIo.writeCustomizationFile(a.path, a.content),
  "customizations:add": (a, c) => c.customizationsIo.addCustomization(a.input as never),
```

```ts
  // teams — board-backed (disk markers) + globalState for type-assignments
  "teams:list": (_a, c) => c.board.listTeams(),
  "campaign:setTeam": (a, c) => { c.board.setTeam("campaign", a.campaignId, a.teamId); return { ok: true }; },
  "mission:setTeam": (a, c) => { c.board.setTeam("mission", a.missionId, a.teamId); return { ok: true }; },
  "team:getBinding": (a, c) => c.board.getTeamBinding(a.scope, a.scopeId),
  "team:setBinding": (a, c) => c.board.setTeamBinding(a.binding),
  "team:assign": async (a, c) => { await c.teamAssignments.set(a.scope, a.scopeId, a.workType, a.teamId); return { ok: true }; },
  "team:assignments": (_a, c) => c.teamAssignments.list(),
```

- [ ] **Step 3: Remove the `TeamAssignments` wiring from `extension.ts`**

Delete the import:

```ts
import { TeamAssignments } from "./host/team-assignments.js";
```

the construction:

```ts
  const teamAssignments = new TeamAssignments(context.globalState);
```

and the `teamAssignments,` field from the `DispatchCtx` object literal.

- [ ] **Step 4: Delete the store and its test**

```bash
rm apps/vscode-extension/src/host/team-assignments.ts
rm -f apps/vscode-extension/test/team-assignments.test.ts
```

- [ ] **Step 5: Fix the dispatcher test**

Open `apps/vscode-extension/test/rpc-dispatcher.test.ts`. Delete any case exercising a removed method and any `teamAssignments` / `customizationsIo` stub in the test's `DispatchCtx`. The exhaustiveness assertion (every key in `rpcArgs` has a handler) stays and now covers the smaller set.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @octoshell/vscode-extension typecheck && pnpm --filter @octoshell/vscode-extension test`
Expected: PASS. `BoardHost.listCustomizations` / `listTeams` / `setTeam` etc. are now unreferenced but still compile — Task 4 removes them.

- [ ] **Step 7: Commit**

```bash
git add -A apps/vscode-extension
git commit -m "refactor(ext): drop the customizations and teams RPC surface"
```

---

### Task 4: Remove the teams and customizations APIs from BoardHost and packages/board

**Files:**
- Modify: `apps/vscode-extension/src/host/board-host.ts` (imports at lines 27-28 and 40-43, `listCustomizations` at lines 225-230, the whole `// ── Teams API ──` region at lines 391-442, the `TeamEntry` type import on line 45)
- Modify: `packages/board/src/write.ts` (`setTeam` at line 760, `getTeam` at line 783)
- Modify: `packages/board/src/index.ts` (re-exports of `setTeam` / `getTeam`)
- Modify: `packages/board/src/types.ts` (`teamId` on `Campaign` line 10 and `Mission` line 23)
- Modify: `packages/board/src/board-model.ts` (the two `teamId: null,` initialisers, lines 97 and 174)
- Delete: `packages/board/test/team-markers.test.ts`
- Modify: `packages/board/test/*` — delete any remaining team assertions
- Modify: `apps/vscode-extension/package.json` (drop the `@octoshell/customizations` dependency)

**Interfaces:**
- Consumes: Task 3 removed every caller of these methods.
- Produces: `Campaign` and `Mission` in `@octoshell/board` no longer have a `teamId` property. `@octoshell/board` no longer exports `setTeam` or `getTeam`.

- [ ] **Step 1: Remove the BoardHost teams and customizations APIs**

In `board-host.ts` delete `setTeam,` and `getTeam,` from the `@octoshell/board` import, delete the entire `@octoshell/customizations` import block:

```ts
import {
  readCustomizations,
  ...
  type CustomizationItem,
} from "@octoshell/customizations";
```

delete `TeamEntry` from the `../protocol/index.js` type import, delete the `listCustomizations()` method, and delete everything from the `// ── Teams API ───` comment through the closing brace of `setTeamBinding` (lines 391-442).

- [ ] **Step 2: Remove the board package's team helpers**

In `packages/board/src/write.ts` delete `export function setTeam(...)` and `export function getTeam(...)` in their entirety, plus any private helper used only by them. In `packages/board/src/index.ts` remove `setTeam` and `getTeam` from the re-export list.

- [ ] **Step 3: Remove `teamId` from the entity types**

In `packages/board/src/types.ts` delete `teamId: string | null;` from both `Campaign` and `Mission`. In `packages/board/src/board-model.ts` delete the two `teamId: null,` lines from the campaign and mission object literals.

- [ ] **Step 4: Delete the team-marker test and run the board tests to find the rest of the fallout**

```bash
rm packages/board/test/team-markers.test.ts
```

Run: `pnpm --filter @octoshell/board test`
Expected: FAIL on any test asserting `teamId` or calling `setTeam`/`getTeam`. Delete those tests and assertions — the feature is removed, not regressed. Re-run until PASS.

- [ ] **Step 5: Rebuild the board package so the extension sees the new types**

Run: `pnpm --filter @octoshell/board build`
Expected: succeeds. This is required before the extension typechecks — downstream reads `dist/`, not source.

- [ ] **Step 6: Drop the customizations dependency**

In `apps/vscode-extension/package.json` remove from `dependencies`:

```json
    "@octoshell/customizations": "workspace:*",
```

Then run: `pnpm install`

- [ ] **Step 7: Verify the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(board): drop the teams API and teamId from campaign/mission"
```

---

### Task 5: Delete the customizations package

**Files:**
- Delete: `packages/customizations/` (entire directory)
- Modify: `pnpm-workspace.yaml` if it names the package explicitly rather than globbing `packages/*`
- Modify: `CLAUDE.md`, `README.md`, `apps/vscode-extension/README.md`, `docs/tech-stack.md`, `docs/prd-v1.md` — remove customizations and teams references

**Interfaces:**
- Consumes: Task 4 removed the last import of `@octoshell/customizations`.
- Produces: the monorepo has one app and one library (`packages/board`, plus `packages/tokenomics`).

- [ ] **Step 1: Confirm nothing imports it**

Run: `grep -rn "@octoshell/customizations" --include="*.ts" --include="*.tsx" --include="*.json" . | grep -v node_modules | grep -v "^./packages/customizations"`
Expected: no output. If anything prints, remove it before continuing.

- [ ] **Step 2: Delete the package**

```bash
rm -rf packages/customizations
```

- [ ] **Step 3: Refresh the workspace**

Run: `pnpm install`
Expected: succeeds; the lockfile drops the package.

- [ ] **Step 4: Update the docs**

In `CLAUDE.md`, rewrite the Libraries section so it lists only `board` (and `tokenomics`), and delete the `customizations` bullet and the `CustomizationsTree` / `CustomizationsIo` mentions in the extension section. Remove the Customizations and Teams paragraphs from `README.md` and `apps/vscode-extension/README.md`. Strike the same from `docs/tech-stack.md` and `docs/prd-v1.md`, marking them historical if the file is a dated record.

- [ ] **Step 5: Verify the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete the customizations package"
```

---

### Task 6: Remove team doctrine from the workflow pack

**Files:**
- Delete: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/create-team.js`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/SKILL.md` (the `## Teams` section at line 271, the `create-team.js` row in `## Scripts`, the `version:` frontmatter)
- Modify: `apps/vscode-extension/src/host/octobots-skill.ts` if it enumerates pack scripts

**Interfaces:**
- Consumes: nothing.
- Produces: pack version 22; no Teams doctrine. Plan 3 adds the Workflows doctrine to the same file.

- [ ] **Step 1: Delete the script**

```bash
rm apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/create-team.js
```

- [ ] **Step 2: Remove the Teams section from SKILL.md**

Open `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/SKILL.md`. Delete the whole `## Teams` section (from the heading at line 271 up to but not including the next `## ` heading). Delete the `create-team.js` row from the `## Scripts` table. Bump the frontmatter `version: 21` to `version: 22`.

- [ ] **Step 3: Check the installer doesn't reference the deleted file**

Run: `grep -rn "create-team\|teams" apps/vscode-extension/src/host/octobots-skill.ts apps/vscode-extension/src/host/octobots-hooks.ts apps/vscode-extension/resources/octobots-pack/`
Expected: no hits other than incidental prose. Remove any that remain.

- [ ] **Step 4: Verify the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pack): v22 — drop team doctrine and create-team.js"
```

---

## Done when

- The Octobots sidebar shows only the Campaigns view.
- Campaign and Mission panels have no Team section.
- `grep -rn "customization\|Customization" --include="*.ts" --include="*.tsx" . | grep -v node_modules` returns nothing.
- `grep -rn "teamId\|TeamAssignments\|listTeams" --include="*.ts" --include="*.tsx" . | grep -v node_modules` returns nothing.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green.
