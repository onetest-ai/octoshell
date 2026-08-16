# Workflows Plan 3 — Extension UI and workflow pack

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface workflows in the Octobots extension — tree nodes, a panel with a read-only diagram and a structured step editor — and teach the workflow pack to author and run them.

**Architecture:** `BoardHost` exposes the `@octoshell/board` workflow API and reconciles after every mutation, exactly like the other entities. The webview gets a `WorkflowView` that renders a hand-rolled SVG diagram from `meta.phases` beside a list editor that round-trips through a `workflow:setMeta` RPC. The pack gains scripts to scaffold workflows and log runs, and `mission-execution` learns to call Claude Code's `Workflow` tool on `workflow.js`.

**Tech Stack:** VS Code extension API, TypeScript ESM (`NodeNext`), React 18 + Tailwind on VS Code CSS-variable theme tokens, vitest + happy-dom + `@testing-library/react`, esbuild (host) + vite (webview).

## Prerequisites

Plan 1 (removals) and Plan 2 (board package) are merged. `pnpm --filter @octoshell/board build` has been run so the extension typechecks against the workflow API.

## Global Constraints

- TypeScript is `module: "NodeNext"`, `strict`, `noUncheckedIndexedAccess`. Relative imports **must** carry the `.js` extension even though sources are `.ts`/`.tsx`.
- Never hardcode colors in the webview — use the CSS-variable VS Code theme tokens (`bg-input`, `border-border`, `text-fg-muted`, `bg-list-active`, …). This applies to SVG `fill`/`stroke` too: use `currentColor` and Tailwind text-color classes, or `var(--vscode-…)`.
- UI icons are VS Code codicons, never emoji. The workflow entity's codicon is **`circuit-board`** everywhere it appears.
- The extension never executes `workflow.js`. Execution is Claude Code's `Workflow` tool.
- Downstream packages consume built `dist/`. After a `packages/board` change run `pnpm --filter @octoshell/board build` before typechecking the extension.
- Repo verification, from the root: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.

---

### Task 1: BoardHost workflow API

**Files:**
- Modify: `apps/vscode-extension/src/host/board-host.ts`
- Create: `apps/vscode-extension/test/board-host-workflow.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `WorkflowParent`, `WorkflowMeta`, `createWorkflow`, `updateWorkflow`, `deleteWorkflow`, `setWorkflowMeta`, `appendWorkflowRun` from `@octoshell/board` (Plan 2).
- Produces on `BoardHost`:
  - `listWorkflows(parent: WorkflowParent): Workflow[]`
  - `getWorkflow(id: string): Workflow | null`
  - `createWorkflow(parent: WorkflowParent, input: { name: string }): { id: string; folderPath: string }`
  - `updateWorkflow(id: string, patch: { description?: string }): void`
  - `setWorkflowMeta(id: string, meta: WorkflowMeta): void`
  - `appendWorkflowRun(id: string, entry: { status: string; summary: string; at: string }): void`
  - `deleteWorkflow(id: string): void`
  - `workflowScriptPath(id: string): string` — absolute path of `workflow.js`

- [ ] **Step 1: Write the failing test**

Create `apps/vscode-extension/test/board-host-workflow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardHost } from "../src/host/board-host.js";

function host(): { board: BoardHost; campaignId: string; missionId: string } {
  const root = mkdtempSync(join(tmpdir(), "host-wf-"));
  const c = join(root, "campaigns", "alpha");
  mkdirSync(join(c, "missions", "m1-auth"), { recursive: true });
  writeFileSync(join(c, "campaign.md"), "# Alpha\n\n## Description\nx\n");
  writeFileSync(join(c, "missions", "m1-auth", "mission.md"), "# M1 - Auth\n\n## Description\nx\n");
  const board = new BoardHost(root);
  const campaignId = board.listCampaigns()[0]!.id;
  return { board, campaignId, missionId: board.listMissions(campaignId)[0]!.id };
}

describe("BoardHost workflows", () => {
  it("creates, lists and reads a campaign workflow", () => {
    const { board, campaignId } = host();
    const { id } = board.createWorkflow({ campaignId }, { name: "Ship Missions" });
    expect(board.listWorkflows({ campaignId }).map((w) => w.id)).toEqual([id]);
    expect(board.getWorkflow(id)!.parseError).toBeNull();
    expect(existsSync(board.workflowScriptPath(id))).toBe(true);
  });

  it("emits entities:changed on every mutation", () => {
    const { board, missionId } = host();
    let fired = 0;
    board.on("entities:changed", () => { fired++; });
    const { id } = board.createWorkflow({ missionId }, { name: "Build" });
    board.updateWorkflow(id, { description: "d" });
    board.appendWorkflowRun(id, { status: "done", summary: "ok", at: "2026-07-23" });
    board.deleteWorkflow(id);
    expect(fired).toBe(4);
  });

  it("writes meta back and keeps the workflow parseable", () => {
    const { board, campaignId } = host();
    const { id } = board.createWorkflow({ campaignId }, { name: "w" });
    board.setWorkflowMeta(id, {
      name: "w",
      description: "d",
      phases: [{ title: "Build", steps: [{ id: "s1", agent: "impl", label: "Build it" }] }],
    });
    const wf = board.getWorkflow(id)!;
    expect(wf.parseError).toBeNull();
    expect(wf.phases[0]!.steps[0]!.label).toBe("Build it");
  });

  it("throws a clear error for an unknown workflow id", () => {
    const { board } = host();
    expect(() => board.workflowScriptPath("folder:nope")).toThrow(/Workflow not found/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @octoshell/vscode-extension test -- board-host-workflow`
Expected: FAIL — `board.createWorkflow` is not a function.

- [ ] **Step 3: Implement the API**

In `apps/vscode-extension/src/host/board-host.ts` extend the `@octoshell/board` import with:

```ts
  createWorkflow as createWorkflowFile,
  updateWorkflow as updateWorkflowFile,
  deleteWorkflow as deleteWorkflowFile,
  setWorkflowMeta as setWorkflowMetaFile,
  appendWorkflowRun as appendWorkflowRunFile,
  type Workflow,
  type WorkflowParent,
  type WorkflowMeta,
```

(the `…File` aliases avoid shadowing the methods being defined below).

Add a `// ── Workflows API ──` region after the bug methods:

```ts
  // ── Workflows API ───────────────────────────────────────────────────────────

  listWorkflows(parent: WorkflowParent): Workflow[] { return this.model.listWorkflows(parent); }
  getWorkflow(id: string): Workflow | null { return this.model.getWorkflow(id); }

  createWorkflow(parent: WorkflowParent, input: { name: string }): { id: string; folderPath: string } {
    const res = createWorkflowFile(this.octobotsDir, parent, input);
    this.reconcile();
    return res;
  }

  updateWorkflow(id: string, patch: { description?: string }): void {
    updateWorkflowFile(this.octobotsDir, id, patch);
    this.reconcile();
  }

  setWorkflowMeta(id: string, meta: WorkflowMeta): void {
    setWorkflowMetaFile(this.octobotsDir, id, meta);
    this.reconcile();
  }

  appendWorkflowRun(id: string, entry: { status: string; summary: string; at: string }): void {
    appendWorkflowRunFile(this.octobotsDir, id, entry);
    this.reconcile();
  }

  deleteWorkflow(id: string): void {
    deleteWorkflowFile(this.octobotsDir, id);
    this.reconcile();
  }

  /** Absolute path of a workflow's script, for opening it in a normal editor tab. */
  workflowScriptPath(id: string): string {
    const wf = this.model.getWorkflow(id);
    if (!wf) throw new Error(`Workflow not found: ${id}`);
    return join(this.octobotsDir, wf.scriptPath);
  }
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @octoshell/vscode-extension test -- board-host-workflow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/vscode-extension/src/host/board-host.ts apps/vscode-extension/test/board-host-workflow.test.ts
git commit -m "feat(ext): BoardHost workflow API"
```

---

### Task 2: Workflow RPC

**Files:**
- Modify: `apps/vscode-extension/src/protocol/rpc-contract.ts`
- Modify: `apps/vscode-extension/src/host/rpc-dispatcher.ts`
- Modify: `apps/vscode-extension/src/webview/octoshell-shim.ts`
- Modify: `apps/vscode-extension/test/rpc-dispatcher.test.ts`

**Interfaces:**
- Consumes: Task 1's `BoardHost` methods.
- Produces these RPC methods, each returning what the matching `BoardHost` method returns (`{ ok: true }` where it returns void):
  - `workflow:list` — `{ campaignId?: string; missionId?: string }` → `Workflow[]`
  - `workflow:get` — `{ workflowId: string }` → `Workflow | null`
  - `workflow:create` — `{ name: string; campaignId?: string; missionId?: string }` → `{ id: string; folderPath: string }`
  - `workflow:update` — `{ workflowId: string; description?: string }` → `{ ok: true }`
  - `workflow:setMeta` — `{ workflowId: string; meta: WorkflowMeta }` → `{ ok: true }`
  - `workflow:addRun` — `{ workflowId: string; status: string; summary: string; at: string }` → `{ ok: true }`
  - `workflow:delete` — `{ workflowId: string }` → `{ ok: true }`
  - `workflow:openScript` — `{ workflowId: string }` → `{ ok: true }`

- [ ] **Step 1: Add the arg schemas**

In `rpc-contract.ts`, beside the existing `// bugs` block, add:

```ts
  // workflows
  "workflow:list": z.object({ campaignId: z.string().optional(), missionId: z.string().optional() }),
  "workflow:get": z.object({ workflowId: z.string() }),
  "workflow:create": z.object({
    name: z.string(),
    campaignId: z.string().optional(),
    missionId: z.string().optional(),
  }),
  "workflow:update": z.object({ workflowId: z.string(), description: z.string().optional() }),
  "workflow:setMeta": z.object({
    workflowId: z.string(),
    meta: z.object({
      name: z.string(),
      description: z.string(),
      phases: z.array(z.object({
        title: z.string(),
        detail: z.string().optional(),
        steps: z.array(z.object({
          id: z.string(),
          agent: z.string(),
          label: z.string(),
          parallel: z.string().optional(),
          dependsOn: z.array(z.string()).optional(),
          backend: z.string().optional(),
        })),
      })),
    }),
  }),
  "workflow:addRun": z.object({
    workflowId: z.string(),
    status: z.string(),
    summary: z.string(),
    at: z.string(),
  }),
  "workflow:delete": z.object({ workflowId: z.string() }),
  "workflow:openScript": z.object({ workflowId: z.string() }),
```

Add the matching entries to the result-type map in the same file, following the shape the bug methods use:

```ts
  "workflow:list": Workflow[];
  "workflow:get": Workflow | null;
  "workflow:create": { id: string; folderPath: string };
  "workflow:update": { ok: true };
  "workflow:setMeta": { ok: true };
  "workflow:addRun": { ok: true };
  "workflow:delete": { ok: true };
  "workflow:openScript": { ok: true };
```

and import the type: `import type { Workflow } from "@octoshell/board";`

- [ ] **Step 2: Add the handlers**

In `rpc-dispatcher.ts` add a `DispatchCtx` capability for opening a file (the dispatcher must stay free of a direct `vscode` import). Extend the `editor` field:

```ts
  /** Host editor capability — keeps this module free of a direct `vscode` import (testable). */
  editor: {
    openReadonly: (content: string, language?: string) => Promise<void>;
    openFile: (absPath: string) => Promise<void>;
  };
```

Then add the handlers beside the bug ones:

```ts
  // workflows — the plan of execution; the script is run by Claude Code, never by the extension
  "workflow:list": (a, c) =>
    c.board.listWorkflows(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId! }),
  "workflow:get": (a, c) => c.board.getWorkflow(a.workflowId),
  "workflow:create": (a, c) =>
    c.board.createWorkflow(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId! }, { name: a.name }),
  "workflow:update": (a, c) => { c.board.updateWorkflow(a.workflowId, { description: a.description }); return { ok: true }; },
  "workflow:setMeta": (a, c) => { c.board.setWorkflowMeta(a.workflowId, a.meta); return { ok: true }; },
  "workflow:addRun": (a, c) => {
    c.board.appendWorkflowRun(a.workflowId, { status: a.status, summary: a.summary, at: a.at });
    return { ok: true };
  },
  "workflow:delete": (a, c) => { c.board.deleteWorkflow(a.workflowId); return { ok: true }; },
  "workflow:openScript": async (a, c) => {
    await c.editor.openFile(c.board.workflowScriptPath(a.workflowId));
    return { ok: true };
  },
```

- [ ] **Step 3: Implement `editor.openFile` in `extension.ts`**

Where the `DispatchCtx` object literal builds `editor`, add:

```ts
      openFile: async (absPath: string) => {
        await vscode.window.showTextDocument(vscode.Uri.file(absPath));
      },
```

- [ ] **Step 4: Add the shim namespace**

In `octoshell-shim.ts` add to the exported interface:

```ts
  workflows: {
    list: (parent: { campaignId?: string; missionId?: string }) => Promise<Workflow[]>;
    get: (workflowId: string) => Promise<Workflow | null>;
    create: (name: string, parent: { campaignId?: string; missionId?: string }) => Promise<{ id: string; folderPath: string }>;
    update: (workflowId: string, description: string) => Promise<{ ok: true }>;
    setMeta: (workflowId: string, meta: WorkflowMeta) => Promise<{ ok: true }>;
    remove: (workflowId: string) => Promise<{ ok: true }>;
    openScript: (workflowId: string) => Promise<{ ok: true }>;
  };
```

and to the implementation object:

```ts
    workflows: {
      list: (parent) => c("workflow:list", parent) as never,
      get: (workflowId) => c("workflow:get", { workflowId }) as never,
      create: (name, parent) => c("workflow:create", { name, ...parent }) as never,
      update: (workflowId, description) => c("workflow:update", { workflowId, description }) as never,
      setMeta: (workflowId, meta) => c("workflow:setMeta", { workflowId, meta }) as never,
      remove: (workflowId) => c("workflow:delete", { workflowId }) as never,
      openScript: (workflowId) => c("workflow:openScript", { workflowId }) as never,
    },
```

with `import type { Workflow, WorkflowMeta } from "@octoshell/board";` at the top.

- [ ] **Step 5: Update the dispatcher test stub**

In `apps/vscode-extension/test/rpc-dispatcher.test.ts`, add `openFile: async () => {}` to the `editor` stub in the test `DispatchCtx`. The existing exhaustiveness assertion now also covers the eight new methods.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @octoshell/vscode-extension typecheck && pnpm --filter @octoshell/vscode-extension test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/vscode-extension/src
git add apps/vscode-extension/test/rpc-dispatcher.test.ts
git commit -m "feat(ext): workflow RPC surface"
```

---

### Task 3: Workflow nodes in the tree, commands, and the panel kind

**Files:**
- Modify: `apps/vscode-extension/src/host/campaigns-tree.ts`
- Modify: `apps/vscode-extension/src/host/entity-panel-manager.ts`
- Modify: `apps/vscode-extension/src/extension.ts`
- Modify: `apps/vscode-extension/package.json`
- Create: `apps/vscode-extension/test/campaigns-tree-workflow.test.ts`

**Interfaces:**
- Consumes: Task 1's `BoardHost.listWorkflows`, Task 2's `workflow:create` / `workflow:delete`.
- Produces: `WORKFLOW_VIEW_TYPE = "octoshell.workflow"` exported from `entity-panel-manager.ts`; `EntityPanelManager.openWorkflow(id)` and `refreshWorkflow(id)`; `Kind` widened to include `"workflow"`; commands `octoshell.newWorkflow`, `octoshell.deleteWorkflow`, `octoshell.openWorkflowById`.

- [ ] **Step 1: Write the failing tree test**

Create `apps/vscode-extension/test/campaigns-tree-workflow.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const { CampaignsTree } = await import("../src/host/campaigns-tree.js");

const workflow = {
  id: "folder:campaigns/a/workflows/w", campaignId: "c1", missionId: null,
  name: "ship", description: "", phases: [], scriptPath: "campaigns/a/workflows/w/workflow.js",
  folderPath: "campaigns/a/workflows/w", parseError: null, lastRunStatus: "done",
  createdAt: 1, updatedAt: 1,
};

const board = {
  listCampaigns: () => [{ id: "c1", name: "Alpha", folderPath: "campaigns/a", createdAt: 1 }],
  listMissions: () => [],
  listTasks: () => [],
  listBugs: () => [],
  listWorkflows: (p: { campaignId?: string }) => (p.campaignId === "c1" ? [workflow] : []),
  campaignRollup: () => ({ rollupStatus: "draft" }),
} as never;

describe("CampaignsTree workflows", () => {
  it("lists a campaign's workflows as children", () => {
    const tree = new CampaignsTree(board);
    const [campaign] = tree.getChildren();
    const children = tree.getChildren(campaign);
    expect(children.some((n: { type: string }) => n.type === "workflow")).toBe(true);
  });

  it("uses the circuit-board codicon", () => {
    const tree = new CampaignsTree(board);
    const item = tree.getTreeItem({ type: "workflow", workflow } as never);
    expect((item.iconPath as { id: string }).id).toBe("circuit-board");
    expect(item.contextValue).toBe("octoshell.workflow");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @octoshell/vscode-extension test -- campaigns-tree-workflow`
Expected: FAIL — no `workflow` node type.

- [ ] **Step 3: Add workflow nodes to the tree**

In `campaigns-tree.ts` widen the `Node` union:

```ts
type Node =
  | { type: "campaign"; campaign: Campaign }
  | { type: "mission"; mission: Mission }
  | { type: "task"; task: Task }
  | { type: "bug"; bug: Bug }
  | { type: "workflow"; workflow: Workflow };
```

adding `Workflow` to the `@octoshell/board` type import.

In `getTreeItem`, before the final bug fallthrough, add:

```ts
    if (node.type === "workflow") {
      const item = new vscode.TreeItem(node.workflow.name, vscode.TreeItemCollapsibleState.None);
      item.description = node.workflow.parseError
        ? "unreadable"
        : `${node.workflow.phases.length} phase${node.workflow.phases.length === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("circuit-board", statusColor(node.workflow.lastRunStatus ?? "draft"));
      item.contextValue = "octoshell.workflow";
      item.command = { command: "octoshell.openWorkflowById", title: "Open Workflow", arguments: [node.workflow.id] };
      return item;
    }
```

In `getChildren`, add workflows first under each parent so the plan of execution reads above the work:

```ts
    if (node.type === "campaign") {
      return [
        ...this.board.listWorkflows({ campaignId: node.campaign.id }).map((workflow) => ({ type: "workflow", workflow }) as Node),
        ...this.board.listMissions(node.campaign.id).map((mission) => ({ type: "mission", mission }) as Node),
        ...this.board.listBugs({ campaignId: node.campaign.id }).map((bug) => ({ type: "bug", bug }) as Node),
      ];
    }
    if (node.type === "mission") {
      return [
        ...this.board.listWorkflows({ missionId: node.mission.id }).map((workflow) => ({ type: "workflow", workflow }) as Node),
        ...this.board.listTasks(node.mission.id).map((task) => ({ type: "task", task }) as Node),
        ...this.board.listBugs({ missionId: node.mission.id }).map((bug) => ({ type: "bug", bug }) as Node),
      ];
    }
```

- [ ] **Step 4: Run the tree test**

Run: `pnpm --filter @octoshell/vscode-extension test -- campaigns-tree-workflow`
Expected: PASS.

- [ ] **Step 5: Add the workflow panel kind**

In `entity-panel-manager.ts`:

```ts
export const WORKFLOW_VIEW_TYPE = "octoshell.workflow";

type Kind = "campaign" | "mission" | "task" | "bug" | "workflow";
```

Add the opener and title helper beside the others:

```ts
  openWorkflow(id: string): void {
    this.open("workflow", id, WORKFLOW_VIEW_TYPE, this.workflowTitle(id));
  }

  /** Public: nudge an open workflow panel to reload. */
  refreshWorkflow(workflowId: string): void {
    this.refreshEntity("workflow", workflowId);
  }

  private workflowTitle(id: string): string {
    return this.ctx.board.getWorkflow(id)?.name ?? "Workflow";
  }
```

Extend `refreshEntity`'s payload chain so `"workflow"` maps to `{ projectId: "workspace", workflowId: id }`:

```ts
    const payload =
      kind === "campaign"
        ? { projectId: "workspace", campaignId: id }
        : kind === "mission"
          ? { projectId: "workspace", missionId: id }
          : kind === "task"
            ? { projectId: "workspace", taskId: id }
            : kind === "bug"
              ? { projectId: "workspace", bugId: id }
              : { projectId: "workspace", workflowId: id };
```

- [ ] **Step 6: Register the commands**

In `extension.ts`, beside the other entity commands, add:

```ts
    vscode.commands.registerCommand("octoshell.openWorkflowById", (workflowId: string) => {
      panels.openWorkflow(workflowId);
    }),
    vscode.commands.registerCommand("octoshell.newWorkflow", async (node?: { campaign?: { id: string }; mission?: { id: string } }) => {
      const parent = node?.campaign ? { campaignId: node.campaign.id } : node?.mission ? { missionId: node.mission.id } : null;
      if (!parent) return;
      const name = await vscode.window.showInputBox({
        prompt: "Workflow name",
        placeHolder: "e.g. build-tasks",
      });
      if (!name) return;
      try {
        const wf = board.createWorkflow(parent, { name });
        campaignsTree.refresh();
        panels.openWorkflow(wf.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not create workflow — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.deleteWorkflow", async (node?: { workflow?: { id: string; name: string } }) => {
      const wf = node?.workflow;
      if (!wf) return;
      const ok = await vscode.window.showWarningMessage(
        `Delete the workflow "${wf.name}"? This permanently removes its workflow.md and workflow.js.`,
        { modal: true },
        "Delete",
      );
      if (ok !== "Delete") return;
      board.deleteWorkflow(wf.id);
      panels.closeEntity("workflow", wf.id);
      campaignsTree.refresh();
    }),
```

Match the local variable names already used in `extension.ts` for the `BoardHost`, the `CampaignsTree` and the `EntityPanelManager` — read the surrounding registrations rather than assuming `board` / `campaignsTree` / `panels`.

- [ ] **Step 7: Contribute the commands and menus**

In `apps/vscode-extension/package.json` add to `contributes.commands`:

```json
      {
        "command": "octoshell.newWorkflow",
        "title": "Octobots: New Workflow",
        "icon": "$(circuit-board)"
      },
      {
        "command": "octoshell.deleteWorkflow",
        "title": "Octobots: Delete Workflow",
        "icon": "$(trash)"
      },
```

and to `contributes.menus["view/item/context"]`:

```json
        {
          "command": "octoshell.newWorkflow",
          "when": "view == octoshell.campaigns && (viewItem == octoshell.campaign || viewItem == octoshell.mission)",
          "group": "1_new"
        },
        {
          "command": "octoshell.deleteWorkflow",
          "when": "view == octoshell.campaigns && viewItem == octoshell.workflow",
          "group": "9_delete"
        }
```

`octoshell.openWorkflowById` is invoked from the tree item only, so it needs no `commands` entry.

- [ ] **Step 8: Verify**

Run: `pnpm --filter @octoshell/vscode-extension typecheck && pnpm --filter @octoshell/vscode-extension test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/vscode-extension
git commit -m "feat(ext): workflow tree nodes, commands and panel kind"
```

---

### Task 4: The workflow diagram component

**Files:**
- Create: `apps/vscode-extension/src/webview/workflow-diagram.tsx`
- Create: `apps/vscode-extension/test/workflow-diagram.test.tsx`

**Interfaces:**
- Consumes: `WorkflowPhase` from `@octoshell/board`.
- Produces: `layoutWorkflow(phases: WorkflowPhase[]): DiagramLayout` and `<WorkflowDiagram phases={…} />`, where:

```ts
export interface DiagramNode { id: string; label: string; agent: string; x: number; y: number; w: number; h: number }
export interface DiagramEdge { from: string; to: string }
export interface DiagramBand { title: string; y: number; h: number }
export interface DiagramLayout { nodes: DiagramNode[]; edges: DiagramEdge[]; bands: DiagramBand[]; width: number; height: number }
```

- [ ] **Step 1: Write the failing test**

Create `apps/vscode-extension/test/workflow-diagram.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { layoutWorkflow, WorkflowDiagram } from "../src/webview/workflow-diagram.js";

// Step labels deliberately differ from phase titles so `getByText` stays unambiguous.
const PHASES = [
  { title: "Plan", steps: [{ id: "s1", agent: "planner", label: "Decompose" }] },
  { title: "Build", steps: [
    { id: "s2", agent: "impl", label: "Build task", parallel: "b" },
    { id: "s3", agent: "test", label: "Write tests", parallel: "b" },
  ] },
  { title: "Review", steps: [{ id: "s4", agent: "rev", label: "Code review", dependsOn: ["s2", "s3"] }] },
];

describe("layoutWorkflow", () => {
  it("places one band per phase, stacked downward", () => {
    const l = layoutWorkflow(PHASES);
    expect(l.bands.map((b) => b.title)).toEqual(["Plan", "Build", "Review"]);
    expect(l.bands[0]!.y).toBeLessThan(l.bands[1]!.y);
    expect(l.bands[1]!.y).toBeLessThan(l.bands[2]!.y);
  });

  it("lays parallel siblings out side by side on the same row", () => {
    const l = layoutWorkflow(PHASES);
    const s2 = l.nodes.find((n) => n.id === "s2")!;
    const s3 = l.nodes.find((n) => n.id === "s3")!;
    expect(s2.y).toBe(s3.y);
    expect(s2.x).not.toBe(s3.x);
  });

  it("draws explicit dependsOn edges and implicit phase-to-phase edges", () => {
    const l = layoutWorkflow(PHASES);
    expect(l.edges).toContainEqual({ from: "s2", to: "s4" });
    expect(l.edges).toContainEqual({ from: "s3", to: "s4" });
    expect(l.edges).toContainEqual({ from: "s1", to: "s2" });
    expect(l.edges).toContainEqual({ from: "s1", to: "s3" });
  });

  it("does not duplicate an edge that is both implicit and explicit", () => {
    const l = layoutWorkflow([
      { title: "A", steps: [{ id: "a", agent: "x", label: "A" }] },
      { title: "B", steps: [{ id: "b", agent: "y", label: "B", dependsOn: ["a"] }] },
    ]);
    expect(l.edges.filter((e) => e.from === "a" && e.to === "b")).toHaveLength(1);
  });

  it("sizes the canvas to fit every node", () => {
    const l = layoutWorkflow(PHASES);
    for (const n of l.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
    }
  });

  it("returns an empty layout for no phases", () => {
    const l = layoutWorkflow([]);
    expect(l.nodes).toEqual([]);
    expect(l.height).toBe(0);
  });
});

describe("WorkflowDiagram", () => {
  it("renders a label and an agent name per step", () => {
    render(<WorkflowDiagram phases={PHASES} />);
    expect(screen.getByText("Decompose")).toBeTruthy();
    expect(screen.getByText("planner")).toBeTruthy();
    expect(screen.getByText("Code review")).toBeTruthy();
  });

  it("renders each phase title", () => {
    render(<WorkflowDiagram phases={PHASES} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Build")).toBeTruthy();
  });

  it("renders a placeholder when there are no phases", () => {
    render(<WorkflowDiagram phases={[]} />);
    expect(screen.getByText(/no phases/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @octoshell/vscode-extension test -- workflow-diagram`
Expected: FAIL — cannot resolve `../src/webview/workflow-diagram.js`.

- [ ] **Step 3: Implement the component**

Create `apps/vscode-extension/src/webview/workflow-diagram.tsx`:

```tsx
/**
 * Read-only workflow diagram.
 *
 * Deterministic layered layout drawn as plain SVG — one horizontal band per phase, steps laid out
 * left-to-right inside their band, edges from every step of a phase to every step of the next
 * (plus explicit `dependsOn` edges). No layout library and no external dependency; colors come from
 * VS Code theme tokens so the diagram themes with the editor.
 */

import type { WorkflowPhase } from "@octoshell/board";

export interface DiagramNode { id: string; label: string; agent: string; x: number; y: number; w: number; h: number }
export interface DiagramEdge { from: string; to: string }
export interface DiagramBand { title: string; y: number; h: number }
export interface DiagramLayout {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  bands: DiagramBand[];
  width: number;
  height: number;
}

const NODE_W = 168;
const NODE_H = 52;
const GAP_X = 24;
const GAP_Y = 44;
const PAD = 16;
const BAND_LABEL_W = 96;

/** Lay phases out top-to-bottom, steps left-to-right within their phase. */
export function layoutWorkflow(phases: WorkflowPhase[]): DiagramLayout {
  if (phases.length === 0) return { nodes: [], edges: [], bands: [], width: 0, height: 0 };

  const nodes: DiagramNode[] = [];
  const bands: DiagramBand[] = [];
  const edges: DiagramEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (from: string, to: string): void => {
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to });
  };

  const widest = Math.max(1, ...phases.map((p) => p.steps.length));
  const width = PAD * 2 + BAND_LABEL_W + widest * NODE_W + (widest - 1) * GAP_X;

  let y = PAD;
  phases.forEach((phase, pi) => {
    bands.push({ title: phase.title, y, h: NODE_H });
    phase.steps.forEach((step, si) => {
      nodes.push({
        id: step.id,
        label: step.label,
        agent: step.agent,
        x: PAD + BAND_LABEL_W + si * (NODE_W + GAP_X),
        y,
        w: NODE_W,
        h: NODE_H,
      });
    });

    // Implicit sequencing: every step of the previous phase feeds every step of this one.
    const prev = phases[pi - 1];
    if (prev) for (const p of prev.steps) for (const s of phase.steps) addEdge(p.id, s.id);

    y += NODE_H + GAP_Y;
  });

  // Explicit dependencies, added after the implicit ones so duplicates collapse.
  for (const phase of phases) {
    for (const step of phase.steps) {
      for (const dep of step.dependsOn ?? []) addEdge(dep, step.id);
    }
  }

  return { nodes, edges, bands, width, height: y - GAP_Y + PAD };
}

export function WorkflowDiagram({ phases }: { phases: WorkflowPhase[] }): JSX.Element {
  const layout = layoutWorkflow(phases);
  if (layout.nodes.length === 0) {
    return <div className="text-sm text-fg-muted p-4">This workflow has no phases yet.</div>;
  }

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-label="Workflow diagram"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="text-fg-muted"
      >
        <defs>
          <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
          </marker>
        </defs>

        {layout.edges.map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const x1 = from.x + from.w / 2;
          const y1 = from.y + from.h;
          const x2 = to.x + to.w / 2;
          const y2 = to.y;
          const mid = (y1 + y2) / 2;
          return (
            <path
              key={`${e.from}->${e.to}`}
              d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.6}
              markerEnd="url(#wf-arrow)"
            />
          );
        })}

        {layout.bands.map((b) => (
          <text
            key={b.title}
            x={PAD}
            y={b.y + b.h / 2 + 4}
            className="fill-current text-xs uppercase"
            fontSize={11}
          >
            {b.title}
          </text>
        ))}

        {layout.nodes.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={4}
              fill="var(--vscode-editorWidget-background)"
              stroke="var(--vscode-widget-border, var(--vscode-editorWidget-border))"
            />
            <text x={n.x + 10} y={n.y + 21} fontSize={12} fill="var(--vscode-foreground)">
              {n.label}
            </text>
            <text x={n.x + 10} y={n.y + 39} fontSize={11} fill="var(--vscode-descriptionForeground)">
              {n.agent}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/vscode-extension test -- workflow-diagram`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/vscode-extension/src/webview/workflow-diagram.tsx apps/vscode-extension/test/workflow-diagram.test.tsx
git commit -m "feat(webview): read-only workflow diagram"
```

---

### Task 5: The WorkflowView panel

**Files:**
- Create: `apps/vscode-extension/src/webview/workflow-view.tsx`
- Create: `apps/vscode-extension/test/workflow-view.test.tsx`
- Modify: `apps/vscode-extension/src/webview/chat-entry.tsx`

**Interfaces:**
- Consumes: `WorkflowDiagram` (Task 4); RPC `workflow:get`, `workflow:update`, `workflow:setMeta`, `workflow:openScript` (Task 2); `RpcClient` and `Field` (existing).
- Produces: `<WorkflowView id={string} rpc={RpcClient} />`, routed from `chat-entry.tsx` on `{ kind: "workflow", id }`.

- [ ] **Step 1: Write the failing test**

Create `apps/vscode-extension/test/workflow-view.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowView } from "../src/webview/workflow-view.js";
import type { RpcClient } from "../src/webview/rpc-client.js";

const WF = {
  id: "folder:campaigns/a/workflows/w",
  campaignId: "c1", missionId: null,
  name: "build-tasks", description: "Drive each task to a PR",
  phases: [{ title: "Build", steps: [{ id: "s1", agent: "impl", label: "Build it" }] }],
  scriptPath: "campaigns/a/workflows/w/workflow.js",
  folderPath: "campaigns/a/workflows/w",
  parseError: null, lastRunStatus: "done", createdAt: 1, updatedAt: 1,
};

function stubRpc(overrides: Record<string, unknown> = {}): { rpc: RpcClient; calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  const rpc = {
    call: vi.fn(async (method: string, args: unknown) => {
      calls.push([method, args]);
      if (method in overrides) return overrides[method];
      if (method === "workflow:get") return WF;
      return { ok: true };
    }),
    onSpineEvent: () => () => {},
  } as unknown as RpcClient;
  return { rpc, calls };
}

describe("WorkflowView", () => {
  it("renders the name, description and diagram", async () => {
    const { rpc } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    expect(await screen.findByText("build-tasks")).toBeTruthy();
    expect(await screen.findByText("Build it")).toBeTruthy();
    expect(await screen.findByText("impl")).toBeTruthy();
  });

  it("writes a step edit back through workflow:setMeta", async () => {
    const { rpc, calls } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    const label = await screen.findByLabelText("Step s1 label");
    fireEvent.change(label, { target: { value: "Build it well" } });
    fireEvent.blur(label);
    await waitFor(() => {
      const call = calls.find(([m]) => m === "workflow:setMeta");
      expect(call).toBeDefined();
      const args = call![1] as { meta: { phases: { steps: { label: string }[] }[] } };
      expect(args.meta.phases[0]!.steps[0]!.label).toBe("Build it well");
    });
  });

  it("adds a step to a phase", async () => {
    const { rpc, calls } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    fireEvent.click(await screen.findByRole("button", { name: /add step/i }));
    await waitFor(() => {
      const call = calls.find(([m]) => m === "workflow:setMeta");
      const args = call![1] as { meta: { phases: { steps: unknown[] }[] } };
      expect(args.meta.phases[0]!.steps).toHaveLength(2);
    });
  });

  it("shows the parse error and hides the editor when the script is unreadable", async () => {
    const broken = { ...WF, parseError: "no `export const meta` object literal found in workflow.js", phases: [] };
    const { rpc } = stubRpc({ "workflow:get": broken });
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    expect(await screen.findByText(/export const meta/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
  });

  it("opens the script", async () => {
    const { rpc, calls } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    fireEvent.click(await screen.findByRole("button", { name: /open script/i }));
    await waitFor(() => {
      expect(calls.some(([m]) => m === "workflow:openScript")).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @octoshell/vscode-extension test -- workflow-view`
Expected: FAIL — cannot resolve `../src/webview/workflow-view.js`.

- [ ] **Step 3: Implement the view**

Create `apps/vscode-extension/src/webview/workflow-view.tsx`:

```tsx
/**
 * WorkflowView — the workflow entity panel.
 *
 * Left: a read-only diagram of the step graph. Right: a structured editor over the same data.
 * Every edit round-trips through `workflow:setMeta`, which rewrites ONLY the `export const meta`
 * literal in workflow.js — the script body is never touched from here. When the script cannot be
 * parsed the editor is withheld and only the error and "Open script" remain: we must never
 * overwrite meta we could not read.
 */

import { useCallback, useEffect, useState } from "react";
import { Field } from "./field.js";
import { WorkflowDiagram } from "./workflow-diagram.js";
import type { RpcClient } from "./rpc-client.js";
import type { RpcResultOf } from "../protocol/index.js";
import type { WorkflowPhase, WorkflowStep } from "@octoshell/board";

type WorkflowData = RpcResultOf<"workflow:get">;

interface Props {
  id: string;
  rpc: RpcClient;
}

const inputClass = "flex-1 bg-input text-fg-input border border-border rounded px-2 py-1 text-sm";

export function WorkflowView({ id, rpc }: Props): JSX.Element {
  const [data, setData] = useState<WorkflowData>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await rpc.call("workflow:get", { workflowId: id }));
  }, [id, rpc]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { workflowId?: string };
      if (e.workflowId === id) void load();
    });
    return off;
  }, [id, rpc, load]);

  /** Persist a whole new phase list, then reload from the host (disk is authoritative). */
  const savePhases = useCallback(
    async (phases: WorkflowPhase[]) => {
      if (!data) return;
      setError(null);
      try {
        await rpc.call("workflow:setMeta", {
          workflowId: id,
          meta: { name: data.name, description: data.description, phases },
        });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data, id, rpc, load],
  );

  const patchStep = useCallback(
    (phaseIndex: number, stepIndex: number, patch: Partial<WorkflowStep>) => {
      if (!data) return;
      const phases = data.phases.map((p, pi) =>
        pi !== phaseIndex
          ? p
          : { ...p, steps: p.steps.map((s, si) => (si !== stepIndex ? s : { ...s, ...patch })) },
      );
      void savePhases(phases);
    },
    [data, savePhases],
  );

  const addStep = useCallback(
    (phaseIndex: number) => {
      if (!data) return;
      const phase = data.phases[phaseIndex];
      if (!phase) return;
      const taken = new Set(data.phases.flatMap((p) => p.steps.map((s) => s.id)));
      let n = taken.size + 1;
      while (taken.has(`s${n}`)) n++;
      const step: WorkflowStep = { id: `s${n}`, agent: "claude", label: "New step" };
      void savePhases(data.phases.map((p, pi) => (pi !== phaseIndex ? p : { ...p, steps: [...p.steps, step] })));
    },
    [data, savePhases],
  );

  const removeStep = useCallback(
    (phaseIndex: number, stepIndex: number) => {
      if (!data) return;
      void savePhases(
        data.phases.map((p, pi) => (pi !== phaseIndex ? p : { ...p, steps: p.steps.filter((_, si) => si !== stepIndex) })),
      );
    },
    [data, savePhases],
  );

  const addPhase = useCallback(() => {
    if (!data) return;
    void savePhases([...data.phases, { title: `Phase ${data.phases.length + 1}`, steps: [] }]);
  }, [data, savePhases]);

  const saveDescription = useCallback(
    async (value: string) => {
      setError(null);
      try {
        await rpc.call("workflow:update", { workflowId: id, description: value });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [id, rpc, load],
  );

  if (!data) return <div className="p-4 text-fg-muted">Loading…</div>;

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-center gap-2">
        <span className="codicon codicon-circuit-board" aria-hidden="true" />
        <h1 className="text-lg">{data.name}</h1>
        {data.lastRunStatus ? (
          <span className="text-xs text-fg-muted">last run: {data.lastRunStatus}</span>
        ) : null}
        <button
          type="button"
          className="ml-auto text-sm border border-border rounded px-2 py-1"
          onClick={() => void rpc.call("workflow:openScript", { workflowId: id })}
        >
          Open script
        </button>
      </header>

      {error ? <div className="text-sm text-fg-error">{error}</div> : null}

      {data.parseError ? (
        <section className="border border-border rounded p-3 space-y-2">
          <h2 className="text-sm uppercase text-fg-muted">Script could not be read</h2>
          <p className="text-sm">{data.parseError}</p>
          <p className="text-sm text-fg-muted">
            Fix <code>{data.scriptPath}</code> so its <code>export const meta</code> is a pure object
            literal, then this panel will render the diagram again.
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <section>
            <h2 className="text-sm uppercase text-fg-muted mb-2">Diagram</h2>
            <WorkflowDiagram phases={data.phases} />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm uppercase text-fg-muted">Steps</h2>
            {data.phases.map((phase, pi) => (
              <div key={`${phase.title}-${pi}`} className="border border-border rounded p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{phase.title}</span>
                  <button
                    type="button"
                    className="ml-auto text-xs border border-border rounded px-2 py-0.5"
                    onClick={() => addStep(pi)}
                  >
                    Add step
                  </button>
                </div>
                {phase.steps.map((step, si) => (
                  <div key={step.id} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs text-fg-muted">{step.id}</span>
                    <input
                      aria-label={`Step ${step.id} label`}
                      className={inputClass}
                      defaultValue={step.label}
                      onBlur={(e) => patchStep(pi, si, { label: e.target.value })}
                    />
                    <input
                      aria-label={`Step ${step.id} agent`}
                      className={inputClass}
                      defaultValue={step.agent}
                      onBlur={(e) => patchStep(pi, si, { agent: e.target.value })}
                    />
                    <input
                      aria-label={`Step ${step.id} parallel group`}
                      className="w-20 bg-input text-fg-input border border-border rounded px-2 py-1 text-sm"
                      placeholder="par"
                      defaultValue={step.parallel ?? ""}
                      onBlur={(e) => patchStep(pi, si, { parallel: e.target.value || undefined })}
                    />
                    <button
                      type="button"
                      aria-label={`Remove step ${step.id}`}
                      className="codicon codicon-trash text-fg-muted"
                      onClick={() => removeStep(pi, si)}
                    />
                  </div>
                ))}
              </div>
            ))}
            <button type="button" className="text-xs border border-border rounded px-2 py-1" onClick={addPhase}>
              Add phase
            </button>
          </section>
        </div>
      )}

      <Field label="Description" value={data.description} onSave={(v) => void saveDescription(v)} />
    </div>
  );
}
```

Check `field.tsx` for `Field`'s actual prop names before wiring it — match them rather than the `label` / `value` / `onSave` shape assumed here.

- [ ] **Step 4: Route it in `chat-entry.tsx`**

Add the import:

```tsx
import { WorkflowView } from "./workflow-view.js";
```

Extend `Bound`:

```tsx
  | { kind: "workflow"; id: string }
```

Extend `resolveBound`, after the `bug` line:

```tsx
  if (m?.kind === "workflow" && m.id) return { kind: "workflow", id: m.id };
```

Extend `Root`, after the `bug` branch:

```tsx
  if (bound.kind === "workflow") {
    return <WorkflowView id={bound.id} rpc={rpc} />;
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @octoshell/vscode-extension test -- workflow-view`
Expected: PASS, all five cases.

- [ ] **Step 6: Verify the extension end to end**

Run: `pnpm --filter @octoshell/vscode-extension typecheck && pnpm --filter @octoshell/vscode-extension build && pnpm --filter @octoshell/vscode-extension test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/vscode-extension/src/webview apps/vscode-extension/test/workflow-view.test.tsx
git commit -m "feat(webview): WorkflowView with diagram and step editor"
```

---

### Task 6: Pack v22 — workflow scripts and doctrine

**Files:**
- Create: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/add-workflow.js`
- Create: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/set-step.js`
- Create: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/add-run.js`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/validate.js`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/list.js`, `show.js`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-planner/SKILL.md`
- Modify: `apps/vscode-extension/resources/octobots-pack/skill/mission-execution/SKILL.md`
- Modify: `packages/board/test/scripts-smoke.test.ts`

**Interfaces:**
- Consumes: the on-disk format established in Plan 2 — `workflows/<slug>/workflow.md` + `workflow.js`, `meta.phases[].steps[]`, `## Runs` board lines.
- Produces three CLIs:
  - `add-workflow.js --campaign <slug> [--mission <slug>] --name <slug> [--description <text>]`
  - `set-step.js --workflow <path-to-workflow-folder> --phase <title> --id <stepId> --agent <name> --label <text> [--parallel <group>] [--depends-on <id,id>] [--backend <name>]`
  - `add-run.js --workflow <path-to-workflow-folder> --status <status> --summary <text> [--at <YYYY-MM-DD>]`

- [ ] **Step 1: Write `add-workflow.js`**

Follow the flag-parsing and exit-code conventions of the existing `create-team.js`-era scripts (`parseArgs`, `process.exit(2)` on bad usage). It must:

1. resolve the parent folder — `.octobots/campaigns/<campaign>` or `.octobots/campaigns/<campaign>/missions/<mission>` — and exit 2 if it does not exist;
2. refuse a second workflow under a mission (exit 2, message `mission already has a workflow`);
3. create `workflows/<name>/workflow.md` containing:

```markdown
# <name>

## Description
<description or _(not set)_>

## Runs
_(not set)_

<!-- Auto-generated by Octobots from the workflow's fields above. The planner owns any sections appended below this comment. -->
## Notes
_(none yet)_
```

4. create `workflows/<name>/workflow.js` containing:

```js
export const meta = {
  name: '<name>',
  description: '<description>',
  phases: [
    { title: 'Run', steps: [{"id":"s1","agent":"claude","label":"<name>"}] },
  ],
}

// Body: use phase() / agent() / parallel() / pipeline().
// Keep `meta.phases` above in step with the phases this body enters —
// the Octobots board draws its diagram from meta, not from this code.
phase('Run')
```

5. print the created folder path.

- [ ] **Step 2: Write `set-step.js`**

It must read `workflow.js`, locate `export const meta = { … }` with the same brace-matching rule as `packages/board/src/workflow-meta.ts` (strings and comments skipped), evaluate the literal with `node:vm` in an empty context, upsert the step into the named phase (creating the phase at the end if it does not exist), re-serialize meta, and write back **only that span**. Exit 2 with a clear message when meta cannot be located or evaluated — never rewrite a script whose meta could not be read.

- [ ] **Step 3: Write `add-run.js`**

Append `- [status:<status>] <at> — <summary>` under `## Runs` in `workflow.md`, replacing the `_(not set)_` placeholder if present and creating the section above the boundary comment if absent. `--at` defaults to today in `YYYY-MM-DD`.

- [ ] **Step 4: Extend `validate.js`**

Walk `workflows/` under every campaign and mission and apply the same rules `packages/board/src/validate.ts` enforces: missing `workflow.js`; unlocatable or non-literal `meta`; `meta.name` not matching the folder slug; no phases; a phase with no steps; a step missing `id`/`agent`/`label`; duplicate step id; `dependsOn` naming an unknown step; a `parallel` group spanning phases; a mission with more than one workflow. Report each as an error line in the script's existing output format.

- [ ] **Step 5: Extend `list.js` and `show.js`**

`list.js` lists a campaign's or mission's workflows with their phase count and last run status. `show.js` prints a workflow's phases and steps as an indented outline.

- [ ] **Step 6: Write the SKILL.md doctrine**

In `mission-planner/SKILL.md`, bump `version:` to `23` and add a `## Workflows` section where `## Teams` used to be (Plan 1 removed it). It must state:

- A **workflow** plans the order of execution and the agents to call. A **campaign** workflow orchestrates its missions; a **mission** workflow orchestrates its tasks. A campaign may hold several; **a mission has at most one**.
- Layout: `.octobots/campaigns/<c>/workflows/<slug>/workflow.md` and `workflow.js` (and the same under `missions/<m>/`).
- `workflow.js` is a **Claude Code dynamic-workflow script**. Its `export const meta` must stay a **pure object literal** — no variables, calls, spreads or template interpolation — because the board reads it without executing the script. If meta becomes non-literal the workflow shows as unreadable in the app.
- The `meta` schema, with this example:

```js
export const meta = {
  name: 'build-tasks',                       // must equal the folder slug
  description: 'Drive each task to a merged PR',
  phases: [
    { title: 'Plan',   steps: [{ id: 's1', agent: 'octobots-planner', label: 'Decompose' }] },
    { title: 'Build',  steps: [
        { id: 's2', agent: 'implementer', label: 'Build task',  parallel: 'b' },
        { id: 's3', agent: 'tester',      label: 'Write tests', parallel: 'b', backend: 'codex' } ] },
    { title: 'Review', steps: [{ id: 's4', agent: 'reviewer', label: 'Review', dependsOn: ['s2','s3'] }] },
  ],
}
```

- Every phase the body enters with `phase('X')` must have a matching `meta.phases` entry, and every step must carry `id`, `agent` and `label`.
- Use `add-workflow.js` / `set-step.js` rather than hand-editing, and run `validate.js` afterwards.
- Runs are logged with `add-run.js`, never hand-written.

- [ ] **Step 7: Teach `mission-execution` to run the workflow**

In `mission-execution/SKILL.md` add a section stating: before executing a mission's tasks, check for `.octobots/<mission-folder>/workflows/*/workflow.js`. If one exists, run it with Claude Code's Workflow tool —

```
Workflow({ scriptPath: ".octobots/campaigns/<c>/missions/<m>/workflows/<w>/workflow.js" })
```

— rather than improvising an execution order. When it finishes, log the outcome with `add-run.js --workflow <folder> --status <done|failed> --summary "<n> agents, <duration>"`. If the mission has no workflow, proceed with the existing task-by-task flow.

- [ ] **Step 8: Extend the scripts smoke test**

In `packages/board/test/scripts-smoke.test.ts`, add cases that shell out to the three new scripts against a temp `.octobots` tree and assert: `add-workflow.js` produces a folder that `BoardModel` parses with `parseError === null`; `set-step.js` adds a step that `BoardModel` then reports; `add-run.js` drives `lastRunStatus`; and `validate.js` exits non-zero on a workflow whose `meta.name` disagrees with its folder.

- [ ] **Step 9: Verify the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add apps/vscode-extension/resources/octobots-pack packages/board/test/scripts-smoke.test.ts
git commit -m "feat(pack): v23 — workflow scripts and doctrine"
```

---

### Task 7: Docs and release

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`, `apps/vscode-extension/README.md`
- Modify: `apps/vscode-extension/package.json` (`version`)

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: documentation describing workflows, and a version bump.

- [ ] **Step 1: Update `CLAUDE.md`**

In the `board` bullet, note that `workflow-meta.ts` reads a workflow script's `meta` literal without executing it, and that `BoardModel` parses `workflows/` under campaigns and missions. In the webview paragraph, add `WorkflowView` to the list of views `chat-entry.tsx` routes to. In the workflow-pack section, describe `add-workflow.js` / `set-step.js` / `add-run.js` and the `mission-execution` handoff to Claude Code's Workflow tool.

- [ ] **Step 2: Update the READMEs**

Add a short "Workflows" section to both: what a workflow is, the two levels, where it lives on disk, and that the extension draws it while Claude Code runs it.

- [ ] **Step 3: Bump the extension version**

In `apps/vscode-extension/package.json` set `"version": "0.0.34"`.

- [ ] **Step 4: Verify the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: document workflows; release 0.0.34 with workflow pack v23"
```

---

## Done when

- The Campaigns tree shows workflow nodes with the `circuit-board` codicon under campaigns and missions, tinted by last run status.
- Opening one shows a diagram of its phases and steps beside an editor; editing a step rewrites only `meta` in `workflow.js`.
- A workflow whose script is unreadable shows the parse error and "Open script", and cannot be silently overwritten.
- `add-workflow.js`, `set-step.js` and `add-run.js` drive the same board the app reads, and `validate.js` enforces the workflow rules.
- `mission-execution` runs a mission's `workflow.js` through Claude Code's Workflow tool and logs the run.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green.
