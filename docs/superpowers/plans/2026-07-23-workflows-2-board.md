# Workflows Plan 2 — The Workflow entity in `packages/board`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Workflow as a fifth board entity in `@octoshell/board` — parsed from disk, created/edited/deleted, and validated — so plan 3 can build UI and pack tooling on top.

**Architecture:** A workflow is a folder holding `workflow.md` (a managed brief with `## Description` and `## Runs`) and `workflow.js` (a Claude Code dynamic-workflow script). The script is the source of truth for the step graph: its `export const meta = { … }` object literal is located by brace matching, evaluated in an empty `node:vm` context (never imported, never executed as a module), and coerced into typed phases and steps. Writes replace only the located meta span, so the script body is never touched.

**Tech Stack:** TypeScript ESM (`NodeNext`), `node:fs`, `node:vm`, vitest.

## Global Constraints

- TypeScript is `module: "NodeNext"`, `strict`, `noUncheckedIndexedAccess`. Relative imports **must** carry the `.js` extension even though sources are `.ts`.
- `noUncheckedIndexedAccess` means every `arr[i]` and `obj[k]` is `T | undefined` — narrow before use or the build fails.
- Disk is authoritative. `BoardModel.rebuild()` is a pure re-parse that clears all state first; never cascade-mutate on read.
- Entities are identified by `folder:<relFolderPath>`. No id marker is written into new files.
- `packages/board` exports its public API through `src/index.ts`.
- The workflow script is **never imported or executed**. Only its `meta` object literal is evaluated, in a null-prototype `node:vm` context with a timeout.
- Verification for this package: `pnpm --filter @octoshell/board test` and `pnpm --filter @octoshell/board build`.

---

### Task 1: Workflow types

**Files:**
- Modify: `packages/board/src/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WorkflowStep`, `WorkflowPhase`, `Workflow`, `WorkflowParent` exported from `@octoshell/board`.

- [ ] **Step 1: Add the types**

Append to `packages/board/src/types.ts`:

```ts
/** One node in a workflow: an agent to call, and how it is ordered against its siblings. */
export interface WorkflowStep {
  /** Unique within the workflow. */
  id: string;
  /** Agent / subagent type to call. */
  agent: string;
  /** Caption shown on the diagram node. */
  label: string;
  /** Steps sharing a group id run concurrently. */
  parallel?: string;
  /** Step ids this step waits for. */
  dependsOn?: string[];
  /** Optional CLI backend override — claude | copilot | codex. */
  backend?: string;
}

/** A band of the workflow diagram. Mirrors an entry of the script's `meta.phases`. */
export interface WorkflowPhase {
  title: string;
  detail?: string;
  steps: WorkflowStep[];
}

/**
 * A workflow: the plan of execution for a campaign (which orchestrates its missions) or a
 * mission (which orchestrates its tasks). Backed by a folder holding `workflow.md` and
 * `workflow.js`; the script's `meta` is the source of truth for `name`/`description`/`phases`.
 */
export interface Workflow {
  id: string;
  /** Exactly one of campaignId / missionId is non-null. */
  campaignId: string | null;
  missionId: string | null;
  name: string;
  description: string;
  phases: WorkflowPhase[];
  /** Repo-relative path of the script, e.g. `campaigns/a/workflows/w/workflow.js`. */
  scriptPath: string;
  folderPath: string;
  /** Non-null when `meta` could not be located, evaluated or coerced. `phases` is then empty. */
  parseError: string | null;
  /** Status of the newest `## Runs` board line, or null when there are no runs. */
  lastRunStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A workflow is parented by exactly one of a campaign or a mission. */
export type WorkflowParent = { campaignId: string } | { missionId: string };
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @octoshell/board build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/board/src/types.ts
git commit -m "feat(board): Workflow, WorkflowPhase, WorkflowStep types"
```

---

### Task 2: Locate and evaluate the `meta` object literal

**Files:**
- Create: `packages/board/src/workflow-meta.ts`
- Create: `packages/board/test/workflow-meta.test.ts`
- Modify: `packages/board/src/index.ts`

**Interfaces:**
- Consumes: `WorkflowPhase`, `WorkflowStep` from Task 1.
- Produces:
  - `findMetaSpan(source: string): MetaSpan | null` where `MetaSpan = { literal: string; start: number; end: number }` — `start`/`end` are indices into `source` of the opening `{` and one past the closing `}`.
  - `parseWorkflowMeta(source: string): WorkflowMeta` where `WorkflowMeta = { name: string; description: string; phases: WorkflowPhase[] }`. Throws `Error` with a human-readable message on any failure.
  - `serializeMeta(meta: WorkflowMeta): string` — a formatted object literal, `{`-to-`}` inclusive, suitable for splicing back over a `MetaSpan`.

- [ ] **Step 1: Write the failing tests**

Create `packages/board/test/workflow-meta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findMetaSpan, parseWorkflowMeta, serializeMeta } from "../src/workflow-meta.js";

const GOOD = `export const meta = {
  name: 'build-tasks',
  description: 'Drive each task to a merged PR',
  phases: [
    { title: 'Plan', steps: [{ id: 's1', agent: 'planner', label: 'Decompose' }] },
    { title: 'Build', steps: [
      { id: 's2', agent: 'impl', label: 'Build', parallel: 'b' },
      { id: 's3', agent: 'test', label: 'Tests', parallel: 'b', backend: 'codex' },
    ] },
    { title: 'Review', detail: 'gate', steps: [{ id: 's4', agent: 'rev', label: 'Review', dependsOn: ['s2', 's3'] }] },
  ],
}

phase('Build')
await agent('go')
`;

describe("findMetaSpan", () => {
  it("locates the literal and its bounds", () => {
    const span = findMetaSpan(GOOD)!;
    expect(span).not.toBeNull();
    expect(GOOD[span.start]).toBe("{");
    expect(GOOD[span.end - 1]).toBe("}");
    expect(span.literal.startsWith("{")).toBe(true);
    expect(span.literal.endsWith("}")).toBe(true);
  });

  it("ignores braces inside strings", () => {
    const src = `export const meta = { name: 'a}b', description: '{', phases: [] }\nphase('x')`;
    const span = findMetaSpan(src)!;
    expect(span.literal).toBe(`{ name: 'a}b', description: '{', phases: [] }`);
  });

  it("ignores braces inside comments", () => {
    const src = `export const meta = {\n  // a } here\n  /* and { here */\n  name: 'a', phases: []\n}\n`;
    expect(findMetaSpan(src)!.literal.endsWith("}")).toBe(true);
    expect(parseWorkflowMeta(src).name).toBe("a");
  });

  it("returns null when there is no meta export", () => {
    expect(findMetaSpan("const x = 1\n")).toBeNull();
  });
});

describe("parseWorkflowMeta", () => {
  it("coerces phases and steps", () => {
    const meta = parseWorkflowMeta(GOOD);
    expect(meta.name).toBe("build-tasks");
    expect(meta.description).toBe("Drive each task to a merged PR");
    expect(meta.phases.map((p) => p.title)).toEqual(["Plan", "Build", "Review"]);
    expect(meta.phases[1]!.steps.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(meta.phases[1]!.steps[0]!.parallel).toBe("b");
    expect(meta.phases[1]!.steps[1]!.backend).toBe("codex");
    expect(meta.phases[2]!.detail).toBe("gate");
    expect(meta.phases[2]!.steps[0]!.dependsOn).toEqual(["s2", "s3"]);
  });

  it("ignores unknown keys instead of rejecting", () => {
    const src = `export const meta = { name: 'a', whenToUse: 'x', phases: [{ title: 'P', model: 'opus', steps: [] }] }`;
    const meta = parseWorkflowMeta(src);
    expect(meta.phases[0]!.title).toBe("P");
  });

  it("defaults missing phases to an empty list", () => {
    expect(parseWorkflowMeta(`export const meta = { name: 'a' }`).phases).toEqual([]);
  });

  it("throws when meta is absent", () => {
    expect(() => parseWorkflowMeta("const x = 1")).toThrow(/no `export const meta`/);
  });

  it("throws rather than executing a non-literal meta", () => {
    const src = `export const meta = { name: readFileSync('/etc/passwd'), phases: [] }`;
    expect(() => parseWorkflowMeta(src)).toThrow();
  });

  it("throws when meta.name is missing", () => {
    expect(() => parseWorkflowMeta(`export const meta = { phases: [] }`)).toThrow(/meta\.name/);
  });

  it("throws when a step has no agent", () => {
    const src = `export const meta = { name: 'a', phases: [{ title: 'P', steps: [{ id: 's1', label: 'x' }] }] }`;
    expect(() => parseWorkflowMeta(src)).toThrow(/agent/);
  });
});

describe("serializeMeta", () => {
  it("round-trips through parseWorkflowMeta", () => {
    const meta = parseWorkflowMeta(GOOD);
    const round = parseWorkflowMeta(`export const meta = ${serializeMeta(meta)}`);
    expect(round).toEqual(meta);
  });

  it("emits an empty step list compactly", () => {
    const meta = { name: "a", description: "", phases: [{ title: "P", steps: [] }] };
    expect(serializeMeta(meta)).toContain("steps: []");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @octoshell/board test -- workflow-meta`
Expected: FAIL — cannot resolve `../src/workflow-meta.js`.

- [ ] **Step 3: Implement `workflow-meta.ts`**

Create `packages/board/src/workflow-meta.ts`:

```ts
/**
 * Reading and writing the `export const meta = { … }` block of a workflow script.
 *
 * The script is a Claude Code dynamic-workflow script and is NEVER imported or executed here.
 * The Workflow contract requires `meta` to be a pure object literal, so we locate that literal by
 * brace matching and evaluate only it, in an empty `node:vm` context: any identifier, call or
 * template interpolation resolves to nothing there and throws instead of running.
 */

import { runInNewContext } from "node:vm";
import type { WorkflowPhase, WorkflowStep } from "./types.js";

export interface MetaSpan {
  /** The literal text, `{` through `}` inclusive. */
  literal: string;
  /** Index of the opening `{` in the source. */
  start: number;
  /** Index one past the closing `}` in the source. */
  end: number;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: WorkflowPhase[];
}

/** Index of the closing quote of the string/template starting at `i`, or `source.length`. */
function skipString(source: string, i: number): number {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === quote) return j;
  }
  return source.length;
}

/**
 * Locate the `export const meta = { … }` object literal, skipping braces that appear inside
 * strings, template literals and comments. Returns null when the export is absent or the
 * literal never closes.
 */
export function findMetaSpan(source: string): MetaSpan | null {
  const decl = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index + decl[0].length);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { literal: source.slice(open, i + 1), start: open, end: i + 1 };
    }
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function coerceStep(raw: unknown, phaseIndex: number, stepIndex: number): WorkflowStep {
  const where = `meta.phases[${phaseIndex}].steps[${stepIndex}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} is not an object`);
  const o = raw as Record<string, unknown>;

  const id = asString(o["id"]);
  if (!id) throw new Error(`${where}.id is missing`);
  const agent = asString(o["agent"]);
  if (!agent) throw new Error(`${where}.agent is missing`);
  const label = asString(o["label"]);
  if (!label) throw new Error(`${where}.label is missing`);

  const step: WorkflowStep = { id, agent, label };
  const parallel = asString(o["parallel"]);
  if (parallel) step.parallel = parallel;
  const backend = asString(o["backend"]);
  if (backend) step.backend = backend;
  const dependsOn = o["dependsOn"];
  if (Array.isArray(dependsOn)) {
    const ids = dependsOn.filter((d): d is string => typeof d === "string");
    if (ids.length) step.dependsOn = ids;
  }
  return step;
}

function coercePhase(raw: unknown, phaseIndex: number): WorkflowPhase {
  const where = `meta.phases[${phaseIndex}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} is not an object`);
  const o = raw as Record<string, unknown>;

  const title = asString(o["title"]);
  if (!title) throw new Error(`${where}.title is missing`);

  const rawSteps = o["steps"];
  const steps = Array.isArray(rawSteps) ? rawSteps.map((s, j) => coerceStep(s, phaseIndex, j)) : [];

  const phase: WorkflowPhase = { title, steps };
  const detail = asString(o["detail"]);
  if (detail) phase.detail = detail;
  return phase;
}

/**
 * Parse a workflow script's `meta`. Throws with a human-readable message when the export is
 * missing, is not a pure literal, or does not match the schema.
 */
export function parseWorkflowMeta(source: string): WorkflowMeta {
  const span = findMetaSpan(source);
  if (!span) throw new Error("no `export const meta` object literal found in workflow.js");

  let raw: unknown;
  try {
    raw = runInNewContext(`(${span.literal})`, Object.create(null) as object, { timeout: 50 });
  } catch (err) {
    throw new Error(`meta is not a pure object literal: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("meta is not an object");

  const o = raw as Record<string, unknown>;
  const name = asString(o["name"]);
  if (!name) throw new Error("meta.name is missing");

  const rawPhases = o["phases"];
  const phases = Array.isArray(rawPhases) ? rawPhases.map((p, i) => coercePhase(p, i)) : [];

  return { name, description: asString(o["description"]) ?? "", phases };
}

/** Render a meta object back into a formatted literal, ready to splice over a `MetaSpan`. */
export function serializeMeta(meta: WorkflowMeta): string {
  const phaseLines = meta.phases.map((p) => {
    const detail = p.detail ? `, detail: ${JSON.stringify(p.detail)}` : "";
    const steps = p.steps.length
      ? `[\n${p.steps.map((s) => `      ${JSON.stringify(s)},`).join("\n")}\n    ]`
      : "[]";
    return `    { title: ${JSON.stringify(p.title)}${detail}, steps: ${steps} },`;
  });
  return [
    "{",
    `  name: ${JSON.stringify(meta.name)},`,
    `  description: ${JSON.stringify(meta.description)},`,
    "  phases: [",
    ...phaseLines,
    "  ],",
    "}",
  ].join("\n");
}
```

- [ ] **Step 4: Export it**

In `packages/board/src/index.ts`, add after the `./slug.js` line:

```ts
export * from "./workflow-meta.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @octoshell/board test -- workflow-meta`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add packages/board/src/workflow-meta.ts packages/board/src/index.ts packages/board/test/workflow-meta.test.ts
git commit -m "feat(board): parse and serialize workflow script meta without executing it"
```

---

### Task 3: Render and parse `workflow.md`

**Files:**
- Modify: `packages/board/src/managed-block.ts` (`EntityKind` line 1, `ManagedFields` lines 4-23, `renderManagedBlock` lines 94-126, `parseManagedBlock` lines 134-165)
- Modify: `packages/board/test/managed-block.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EntityKind` gains `"workflow"`. `ManagedFields` gains `runs?: string`. `renderManagedBlock("workflow", fields, [], "planner")` renders a heading, `## Description`, `## Runs` and the boundary comment. `parseManagedBlock` returns `runs`.

- [ ] **Step 1: Write the failing test**

Append to `packages/board/test/managed-block.test.ts`:

```ts
describe("workflow briefs", () => {
  it("renders Description and Runs and no Acceptance Criteria", () => {
    const md = renderManagedBlock("workflow", {
      name: "build-tasks",
      description: "Drive each task to a merged PR",
      acceptanceCriteria: "",
      runs: "- [status:done] 2026-07-23 — 4 agents, 12m",
    }, [], "planner");
    expect(md).toContain("# build-tasks");
    expect(md).toContain("## Description");
    expect(md).toContain("## Runs");
    expect(md).not.toContain("## Acceptance Criteria");
    expect(md).toContain("Auto-generated by Octobots");
  });

  it("round-trips the Runs section", () => {
    const md = renderManagedBlock("workflow", {
      name: "w", description: "d", acceptanceCriteria: "",
      runs: "- [status:failed] 2026-07-22 — review phase",
    }, [], "planner");
    expect(parseManagedBlock(md).runs).toBe("- [status:failed] 2026-07-22 — review phase");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @octoshell/board test -- managed-block`
Expected: FAIL — `"workflow"` is not assignable to `EntityKind`.

- [ ] **Step 3: Extend `EntityKind` and `ManagedFields`**

In `packages/board/src/managed-block.ts` change line 1 to:

```ts
export type EntityKind = "campaign" | "mission" | "task" | "bug" | "workflow";
```

and add to `ManagedFields`, after `environment?: string;`:

```ts
  /** workflow only — the raw body of the `## Runs` section. */
  runs?: string;
```

- [ ] **Step 4: Add the workflow branch to `renderManagedBlock`**

Replace the `if (kind === "bug") { … } else { … }` chain body's opening so it reads:

```ts
  if (kind === "workflow") {
    lines.push(section("Description", fields.description));
    lines.push(section("Runs", fields.runs ?? ""));
  } else if (kind === "bug") {
```

leaving the existing bug and else branches untouched.

- [ ] **Step 5: Parse the Runs section**

In `parseManagedBlock`'s returned object, add after `environment: sectionBody("Environment"),`:

```ts
    runs: sectionBody("Runs"),
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @octoshell/board test`
Expected: PASS. If a test or a `switch (kind)` elsewhere is now non-exhaustive, the compiler names it — handle `"workflow"` by falling through to the existing default.

- [ ] **Step 7: Commit**

```bash
git add packages/board/src/managed-block.ts packages/board/test/managed-block.test.ts
git commit -m "feat(board): workflow briefs render Description and Runs"
```

---

### Task 4: Parse workflows in `BoardModel`

**Files:**
- Modify: `packages/board/src/board-model.ts`
- Modify: `packages/board/test/board-model.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `WorkflowParent` (Task 1), `parseWorkflowMeta` (Task 2), `parseManagedBlock` with `runs` (Task 3).
- Produces: `BoardModel.listWorkflows(parent: WorkflowParent): Workflow[]`, `BoardModel.getWorkflow(id: string): Workflow | null`, `BoardModel.workflowIdByFolderPath(folderPath: string): string | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/board/test/board-model.test.ts` (follow the file's existing temp-dir fixture helper; if it has none, write files with `mkdirSync`/`writeFileSync` under `mkdtempSync(join(tmpdir(), "board-"))`):

```ts
describe("workflows", () => {
  it("parses a campaign workflow and a mission workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "board-wf-"));
    const c = join(root, "campaigns", "alpha");
    mkdirSync(join(c, "workflows", "ship-missions"), { recursive: true });
    writeFileSync(join(c, "campaign.md"), "# Alpha\n\n## Description\nx\n");
    writeFileSync(
      join(c, "workflows", "ship-missions", "workflow.md"),
      "# ship-missions\n\n## Description\nShip them\n\n## Runs\n- [status:done] 2026-07-23 — ok\n",
    );
    writeFileSync(
      join(c, "workflows", "ship-missions", "workflow.js"),
      "export const meta = { name: 'ship-missions', description: 'd', phases: [{ title: 'Go', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\n",
    );

    const m = join(c, "missions", "m1-auth");
    mkdirSync(join(m, "workflows", "build-tasks"), { recursive: true });
    writeFileSync(join(m, "mission.md"), "# M1 - Auth\n\n## Description\nx\n");
    writeFileSync(join(m, "workflows", "build-tasks", "workflow.md"), "# build-tasks\n\n## Description\nBuild\n");
    writeFileSync(
      join(m, "workflows", "build-tasks", "workflow.js"),
      "export const meta = { name: 'build-tasks', phases: [] }\n",
    );

    const board = new BoardModel(root);
    board.rebuild();

    const campaignId = board.listCampaigns()[0]!.id;
    const missionId = board.listMissions(campaignId)[0]!.id;

    const cw = board.listWorkflows({ campaignId });
    expect(cw).toHaveLength(1);
    expect(cw[0]!.name).toBe("ship-missions");
    expect(cw[0]!.campaignId).toBe(campaignId);
    expect(cw[0]!.missionId).toBeNull();
    expect(cw[0]!.phases[0]!.steps[0]!.agent).toBe("a");
    expect(cw[0]!.lastRunStatus).toBe("done");
    expect(cw[0]!.scriptPath).toBe("campaigns/alpha/workflows/ship-missions/workflow.js");
    expect(cw[0]!.parseError).toBeNull();

    const mw = board.listWorkflows({ missionId });
    expect(mw).toHaveLength(1);
    expect(mw[0]!.missionId).toBe(missionId);
    expect(mw[0]!.lastRunStatus).toBeNull();

    expect(board.getWorkflow(cw[0]!.id)!.name).toBe("ship-missions");
    expect(board.workflowIdByFolderPath("campaigns/alpha/workflows/ship-missions")).toBe(cw[0]!.id);
  });

  it("surfaces an unreadable script as parseError instead of dropping the workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "board-wf-bad-"));
    const c = join(root, "campaigns", "alpha");
    mkdirSync(join(c, "workflows", "broken"), { recursive: true });
    writeFileSync(join(c, "campaign.md"), "# Alpha\n\n## Description\nx\n");
    writeFileSync(join(c, "workflows", "broken", "workflow.md"), "# broken\n\n## Description\nd\n");
    writeFileSync(join(c, "workflows", "broken", "workflow.js"), "const notMeta = 1\n");

    const board = new BoardModel(root);
    board.rebuild();
    const campaignId = board.listCampaigns()[0]!.id;
    const [wf] = board.listWorkflows({ campaignId });
    expect(wf).toBeDefined();
    expect(wf!.parseError).toMatch(/export const meta/);
    expect(wf!.phases).toEqual([]);
    expect(wf!.name).toBe("broken");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @octoshell/board test -- board-model`
Expected: FAIL — `listWorkflows` is not a function.

- [ ] **Step 3: Add the state and indexes**

In `packages/board/src/board-model.ts`, add to the imports:

```ts
import { parseWorkflowMeta } from "./workflow-meta.js";
import type { Campaign, Mission, Task, Bug, BugSeverity, Workflow, WorkflowParent } from "./types.js";
```

(merge `Workflow` and `WorkflowParent` into the existing type imports rather than duplicating them).

Add these fields beside the other maps:

```ts
  private workflows = new Map<string, Workflow>();
  private workflowsByCampaign = new Map<string, string[]>();
  private workflowsByMission = new Map<string, string[]>();
  private workflowByFolder = new Map<string, string>();
```

and clear all four at the top of `rebuild()`, alongside the existing `.clear()` calls.

- [ ] **Step 4: Add the parsing helper**

Add near the other private helpers at the bottom of the file:

```ts
/**
 * Parse every workflow folder under `<parentFolder>/workflows/`. A workflow whose script cannot be
 * read is still returned, carrying `parseError` — an unreadable workflow must be visible on the
 * board, not silently absent.
 */
function parseWorkflows(
  root: string,
  parentFolder: string,
  parent: { campaignId: string } | { missionId: string },
): Workflow[] {
  const out: Workflow[] = [];
  const dir = join(root, parentFolder, "workflows");
  for (const slug of safeReaddir(dir)) {
    const folderPath = `${parentFolder}/workflows/${slug}`;
    const mdPath = join(root, folderPath, "workflow.md");
    const mdText = safeReadFile(mdPath);
    if (mdText === null) continue; // no workflow.md → not a workflow folder

    const fields = parseManagedBlock(mdText);
    const jsPath = join(root, folderPath, "workflow.js");
    const jsText = safeReadFile(jsPath);

    let name = fields.name || deSlug(slug);
    let description = fields.description ?? "";
    let phases: WorkflowPhase[] = [];
    let parseError: string | null = null;

    if (jsText === null) {
      parseError = "workflow.js is missing";
    } else {
      try {
        const meta = parseWorkflowMeta(jsText);
        name = meta.name;
        if (meta.description) description = meta.description;
        phases = meta.phases;
      } catch (err) {
        parseError = (err as Error).message;
      }
    }

    const mtime = safeMtime(mdPath);
    out.push({
      id: `folder:${folderPath}`,
      campaignId: "campaignId" in parent ? parent.campaignId : null,
      missionId: "missionId" in parent ? parent.missionId : null,
      name,
      description,
      phases,
      scriptPath: `${folderPath}/workflow.js`,
      folderPath,
      parseError,
      lastRunStatus: newestRunStatus(fields.runs ?? ""),
      createdAt: mtime,
      updatedAt: mtime,
    });
  }
  return out;
}

/** Status of the last `- [status:x] …` line in a `## Runs` body, or null when there are none. */
function newestRunStatus(runsBody: string): string | null {
  let last: string | null = null;
  for (const line of runsBody.split("\n")) {
    const m = line.match(/^\s*-\s*\[status:([^\]]+)\]/i);
    if (!m) continue;
    const mapped = mapBoardStatus((m[1] ?? "").trim());
    if (mapped) last = mapped;
  }
  return last;
}
```

Import `WorkflowPhase` alongside the other types, and `parseManagedBlock` is already imported.

- [ ] **Step 5: Call it from `rebuild()`**

Inside the campaign loop, immediately after `this.bugsByCampaign.set(cId, []);`, add:

```ts
      this.workflowsByCampaign.set(cId, []);
      for (const wf of parseWorkflows(this.root, cFolder, { campaignId: cId })) {
        this.workflows.set(wf.id, wf);
        this.workflowByFolder.set(wf.folderPath, wf.id);
        this.workflowsByCampaign.get(cId)!.push(wf.id);
      }
```

Inside the mission loop, immediately after `this.bugsByMission.set(mId, []);`, add:

```ts
        this.workflowsByMission.set(mId, []);
        for (const wf of parseWorkflows(this.root, mFolder, { missionId: mId })) {
          this.workflows.set(wf.id, wf);
          this.workflowByFolder.set(wf.folderPath, wf.id);
          this.workflowsByMission.get(mId)!.push(wf.id);
        }
```

- [ ] **Step 6: Add the read API**

Add to the `// ── Read API ──` region, after `getBug`:

```ts
  /** Workflows for a campaign or mission parent, sorted newest-first. */
  listWorkflows(parent: WorkflowParent): Workflow[] {
    const ids =
      "campaignId" in parent
        ? this.workflowsByCampaign.get(parent.campaignId) ?? []
        : this.workflowsByMission.get(parent.missionId) ?? [];
    const entities = ids
      .map((id) => this.workflows.get(id))
      .filter((w): w is Workflow => w !== undefined);
    return sortEntities(entities);
  }

  getWorkflow(id: string): Workflow | null {
    return this.workflows.get(id) ?? null;
  }
```

and to the folder-index region:

```ts
  workflowIdByFolderPath(folderPath: string): string | null {
    return this.workflowByFolder.get(folderPath) ?? null;
  }
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @octoshell/board test -- board-model`
Expected: PASS both new cases and all pre-existing ones.

- [ ] **Step 8: Commit**

```bash
git add packages/board/src/board-model.ts packages/board/test/board-model.test.ts
git commit -m "feat(board): BoardModel parses campaign and mission workflows"
```

---

### Task 5: Create, update, delete workflows

**Files:**
- Modify: `packages/board/src/write.ts`
- Create: `packages/board/test/write-workflow.test.ts`

**Interfaces:**
- Consumes: `parseWorkflowMeta`, `serializeMeta`, `findMetaSpan` (Task 2); `renderManagedBlock` with `"workflow"` (Task 3); `BoardModel.getWorkflow` / `listWorkflows` (Task 4).
- Produces:
  - `createWorkflow(root: string, parent: WorkflowParent, input: { name: string; description?: string }): { id: string; folderPath: string }`
  - `updateWorkflow(root: string, id: string, patch: { description?: string }): boolean`
  - `deleteWorkflow(root: string, id: string): boolean`
  - `setWorkflowMeta(root: string, id: string, meta: WorkflowMeta): boolean`
  - `appendWorkflowRun(root: string, id: string, entry: { status: string; summary: string; at: string }): boolean`

- [ ] **Step 1: Write the failing tests**

Create `packages/board/test/write-workflow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardModel } from "../src/board-model.js";
import {
  createWorkflow, updateWorkflow, deleteWorkflow, setWorkflowMeta, appendWorkflowRun,
} from "../src/write.js";

function fixture(): { root: string; campaignId: string; missionId: string } {
  const root = mkdtempSync(join(tmpdir(), "wf-write-"));
  const c = join(root, "campaigns", "alpha");
  mkdirSync(join(c, "missions", "m1-auth"), { recursive: true });
  writeFileSync(join(c, "campaign.md"), "# Alpha\n\n## Description\nx\n");
  writeFileSync(join(c, "missions", "m1-auth", "mission.md"), "# M1 - Auth\n\n## Description\nx\n");
  const board = new BoardModel(root);
  board.rebuild();
  const campaignId = board.listCampaigns()[0]!.id;
  return { root, campaignId, missionId: board.listMissions(campaignId)[0]!.id };
}

function read(root: string, id: string, file: string): string {
  const board = new BoardModel(root);
  board.rebuild();
  return readFileSync(join(root, board.getWorkflow(id)!.folderPath, file), "utf8");
}

describe("createWorkflow", () => {
  it("scaffolds a parseable workflow under a campaign", () => {
    const { root, campaignId } = fixture();
    const { folderPath } = createWorkflow(root, { campaignId }, { name: "Ship Missions" });
    expect(folderPath).toBe("campaigns/alpha/workflows/ship-missions");
    expect(existsSync(join(root, folderPath, "workflow.md"))).toBe(true);
    expect(existsSync(join(root, folderPath, "workflow.js"))).toBe(true);

    const board = new BoardModel(root);
    board.rebuild();
    const [wf] = board.listWorkflows({ campaignId });
    expect(wf!.parseError).toBeNull();
    expect(wf!.name).toBe("ship-missions");
    expect(wf!.phases).toHaveLength(1);
  });

  it("scaffolds under a mission and de-duplicates slugs", () => {
    const { root, missionId } = fixture();
    const a = createWorkflow(root, { missionId }, { name: "Build" });
    const b = createWorkflow(root, { missionId }, { name: "Build" });
    expect(a.folderPath).not.toBe(b.folderPath);
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.listWorkflows({ missionId })).toHaveLength(2);
  });
});

describe("updateWorkflow", () => {
  it("edits the description in workflow.md and leaves the script alone", () => {
    const { root, campaignId } = fixture();
    const { id } = createWorkflow(root, { campaignId }, { name: "w" });
    const before = read(root, id, "workflow.js");
    expect(updateWorkflow(root, id, { description: "new text" })).toBe(true);
    expect(read(root, id, "workflow.md")).toContain("new text");
    expect(read(root, id, "workflow.js")).toBe(before);
  });
});

describe("setWorkflowMeta", () => {
  it("replaces only the meta span and preserves the body byte-for-byte", () => {
    const { root, campaignId } = fixture();
    const { id, folderPath } = createWorkflow(root, { campaignId }, { name: "w" });
    const body = "\n\n// a hand-written body\nphase('Go')\nawait agent('do it')\n";
    const original = readFileSync(join(root, folderPath, "workflow.js"), "utf8");
    writeFileSync(join(root, folderPath, "workflow.js"), original.trimEnd() + body, "utf8");

    expect(setWorkflowMeta(root, id, {
      name: "w",
      description: "d",
      phases: [{ title: "Go", steps: [{ id: "s1", agent: "impl", label: "Build" }] }],
    })).toBe(true);

    const after = read(root, id, "workflow.js");
    expect(after).toContain("// a hand-written body");
    expect(after).toContain("await agent('do it')");

    const board = new BoardModel(root);
    board.rebuild();
    const wf = board.getWorkflow(id)!;
    expect(wf.parseError).toBeNull();
    expect(wf.phases[0]!.steps[0]!.label).toBe("Build");
  });
});

describe("appendWorkflowRun", () => {
  it("appends a board line and drives lastRunStatus", () => {
    const { root, campaignId } = fixture();
    const { id } = createWorkflow(root, { campaignId }, { name: "w" });
    expect(appendWorkflowRun(root, id, { status: "done", summary: "4 agents, 12m", at: "2026-07-23" })).toBe(true);
    expect(appendWorkflowRun(root, id, { status: "failed", summary: "review phase", at: "2026-07-24" })).toBe(true);

    const md = read(root, id, "workflow.md");
    expect(md).toContain("- [status:done] 2026-07-23 — 4 agents, 12m");
    expect(md).toContain("- [status:failed] 2026-07-24 — review phase");

    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getWorkflow(id)!.lastRunStatus).toBe("failed");
  });
});

describe("deleteWorkflow", () => {
  it("removes the folder", () => {
    const { root, campaignId } = fixture();
    const { id, folderPath } = createWorkflow(root, { campaignId }, { name: "w" });
    expect(deleteWorkflow(root, id)).toBe(true);
    expect(existsSync(join(root, folderPath, "workflow.md"))).toBe(false);
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.listWorkflows({ campaignId })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @octoshell/board test -- write-workflow`
Expected: FAIL — `createWorkflow` is not exported.

- [ ] **Step 3: Implement the writers**

Append to `packages/board/src/write.ts`:

```ts
// ── Workflows ────────────────────────────────────────────────────────────────

/** The scaffold body written beside a new workflow's meta — a valid, runnable single-phase script. */
function scaffoldScript(meta: WorkflowMeta): string {
  return [
    `export const meta = ${serializeMeta(meta)}`,
    "",
    "// Body: use phase() / agent() / parallel() / pipeline().",
    "// Keep `meta.phases` above in step with the phases this body enters —",
    "// the Octobots board draws its diagram from meta, not from this code.",
    `phase(${JSON.stringify(meta.phases[0]?.title ?? "Run")})`,
    "",
  ].join("\n");
}

export function createWorkflow(
  root: string,
  parent: WorkflowParent,
  input: { name: string; description?: string },
): { id: string; folderPath: string } {
  const board = new BoardModel(root);
  board.rebuild();
  const parentEntity =
    "campaignId" in parent ? board.getCampaign(parent.campaignId) : board.getMission(parent.missionId);
  if (!parentEntity) throw new Error("Workflow parent not found");

  const workflowsDir = join(root, parentEntity.folderPath, "workflows");
  const slug = uniqueSlug(slugify(input.name), siblingSlugs(workflowsDir));
  const folderPath = `${parentEntity.folderPath}/workflows/${slug}`;
  const description = input.description ?? "";

  writeBrief(join(root, folderPath), "workflow", {
    name: slug,
    description,
    acceptanceCriteria: "",
    runs: "",
  }, "## Notes\n_(none yet)_\n");

  writeFileSync(
    join(root, folderPath, "workflow.js"),
    scaffoldScript({
      name: slug,
      description,
      phases: [{ title: "Run", steps: [{ id: "s1", agent: "claude", label: input.name }] }],
    }),
    "utf8",
  );

  return { id: `folder:${folderPath}`, folderPath };
}

/** Absolute path of a workflow's folder, or null when the id is unknown. */
function workflowFolder(root: string, id: string): string | null {
  const board = new BoardModel(root);
  board.rebuild();
  const wf = board.getWorkflow(id);
  return wf ? join(root, wf.folderPath) : null;
}

export function updateWorkflow(root: string, id: string, patch: { description?: string }): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  const mdPath = join(folder, "workflow.md");
  if (!existsSync(mdPath)) return false;

  const text = readFileSync(mdPath, "utf8");
  const fields = parseManagedBlock(text);
  const boundary = text.indexOf("<!-- Auto-generated by Octobots");
  const tail = boundary >= 0 ? text.slice(text.indexOf("\n", boundary) + 1) : "";

  const merged: ManagedFields = {
    ...fields,
    description: patch.description ?? fields.description,
  };
  writeFileSync(mdPath, renderManagedBlock("workflow", merged, [], "planner") + tail, "utf8");
  return true;
}

export function setWorkflowMeta(root: string, id: string, meta: WorkflowMeta): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  const jsPath = join(folder, "workflow.js");
  if (!existsSync(jsPath)) return false;

  const source = readFileSync(jsPath, "utf8");
  const span = findMetaSpan(source);
  if (!span) return false; // never rewrite a script whose meta we could not locate

  writeFileSync(jsPath, source.slice(0, span.start) + serializeMeta(meta) + source.slice(span.end), "utf8");
  return true;
}

export function appendWorkflowRun(
  root: string,
  id: string,
  entry: { status: string; summary: string; at: string },
): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  const mdPath = join(folder, "workflow.md");
  if (!existsSync(mdPath)) return false;

  const line = `- [status:${entry.status}] ${entry.at} — ${entry.summary}`;
  let text = readFileSync(mdPath, "utf8");
  const head = text.search(/^##\s+Runs\s*$/m);
  if (head < 0) {
    // No Runs section (hand-written file) — create it above the boundary comment.
    const boundary = text.indexOf("<!-- Auto-generated by Octobots");
    const insertAt = boundary >= 0 ? boundary : text.length;
    text = `${text.slice(0, insertAt)}## Runs\n${line}\n\n${text.slice(insertAt)}`;
  } else {
    const rest = text.slice(head);
    const nextHeading = rest.search(/\n(?=##\s+|<!--)/);
    const insertAt = nextHeading >= 0 ? head + nextHeading : text.length;
    const before = text.slice(0, insertAt).replace(/\n?_\(not set\)_\n?/, "\n");
    text = `${before.endsWith("\n") ? before : before + "\n"}${line}\n${text.slice(insertAt)}`;
  }
  writeFileSync(mdPath, text, "utf8");
  return true;
}

export function deleteWorkflow(root: string, id: string): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  return trashFolder(folder, root);
}
```

Extend the imports at the top of `write.ts`:

```ts
import { type BugParent, type BugSeverity, type WorkflowParent } from "./types.js";
import { findMetaSpan, serializeMeta, type WorkflowMeta } from "./workflow-meta.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/board test -- write-workflow`
Expected: PASS. If `appendWorkflowRun` places the line in the wrong section, fix the insertion, not the assertion — the `## Runs` body must stay above the boundary comment so `parseManagedBlock` finds it.

- [ ] **Step 5: Run the whole package**

Run: `pnpm --filter @octoshell/board test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/board/src/write.ts packages/board/test/write-workflow.test.ts
git commit -m "feat(board): create, update, delete and run-log workflows"
```

---

### Task 6: Validate workflows

**Files:**
- Modify: `packages/board/src/validate.ts`
- Modify: `packages/board/test/validate.test.ts`

**Interfaces:**
- Consumes: `parseWorkflowMeta` (Task 2), `BoardFinding` (existing).
- Produces: `validateWorkflow(mdPath: string, jsPath: string, folderSlug: string): BoardFinding[]`, called from `validateBoard` for every campaign and mission workflow folder, plus a one-workflow-per-mission check inside `validateBoard`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/board/test/validate.test.ts`:

```ts
describe("workflow validation", () => {
  function wfBoard(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "wf-val-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, ".octobots", rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return root;
  }

  const CAMPAIGN = "# Alpha\n\n## Description\nA real description here.\n\n## Acceptance Criteria\n- [ ] ships\n";
  const MISSION = "# M1 - Auth\n\n## Description\nA real description here.\n\n## Acceptance Criteria\n- [ ] ships\n";
  const WF_MD = "# w\n\n## Description\nA workflow.\n";

  it("reports a missing meta export", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
      "campaigns/alpha/workflows/w/workflow.js": "const x = 1\n",
    });
    const messages = validateBoard(root).map((f) => f.message);
    expect(messages.some((m) => /export const meta/.test(m))).toBe(true);
  });

  it("reports a missing workflow.js", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
    });
    expect(validateBoard(root).some((f) => /workflow\.js is missing/.test(f.message))).toBe(true);
  });

  it("reports a name that does not match the folder slug", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
      "campaigns/alpha/workflows/w/workflow.js":
        "export const meta = { name: 'other', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\n",
    });
    expect(validateBoard(root).some((f) => /does not match its folder/.test(f.message))).toBe(true);
  });

  it("reports no phases, empty phases, duplicate ids, unknown dependsOn and split parallel groups", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/none/workflow.md": WF_MD,
      "campaigns/alpha/workflows/none/workflow.js": "export const meta = { name: 'none', phases: [] }\n",
      "campaigns/alpha/workflows/empty/workflow.md": WF_MD,
      "campaigns/alpha/workflows/empty/workflow.js":
        "export const meta = { name: 'empty', phases: [{ title: 'P', steps: [] }] }\n",
      "campaigns/alpha/workflows/dup/workflow.md": WF_MD,
      "campaigns/alpha/workflows/dup/workflow.js":
        "export const meta = { name: 'dup', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }, { id: 's1', agent: 'b', label: 'm' }] }] }\n",
      "campaigns/alpha/workflows/dep/workflow.md": WF_MD,
      "campaigns/alpha/workflows/dep/workflow.js":
        "export const meta = { name: 'dep', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l', dependsOn: ['nope'] }] }] }\n",
      "campaigns/alpha/workflows/par/workflow.md": WF_MD,
      "campaigns/alpha/workflows/par/workflow.js":
        "export const meta = { name: 'par', phases: [{ title: 'A', steps: [{ id: 's1', agent: 'a', label: 'l', parallel: 'g' }] }, { title: 'B', steps: [{ id: 's2', agent: 'b', label: 'm', parallel: 'g' }] }] }\n",
    });
    const messages = validateBoard(root).map((f) => f.message).join("\n");
    expect(messages).toMatch(/has no phases/);
    expect(messages).toMatch(/phase "P" has no steps/);
    expect(messages).toMatch(/duplicate step id "s1"/);
    expect(messages).toMatch(/dependsOn "nope"/);
    expect(messages).toMatch(/parallel group "g" spans more than one phase/);
  });

  it("reports a mission with more than one workflow", () => {
    const good = "export const meta = { name: 'NAME', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\n";
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/missions/m1/mission.md": MISSION,
      "campaigns/alpha/missions/m1/workflows/a/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/a/workflow.js": good.replace("NAME", "a"),
      "campaigns/alpha/missions/m1/workflows/b/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/b/workflow.js": good.replace("NAME", "b"),
    });
    expect(validateBoard(root).some((f) => /more than one workflow/.test(f.message))).toBe(true);
  });

  it("passes a well-formed workflow", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/ok/workflow.md": WF_MD,
      "campaigns/alpha/workflows/ok/workflow.js":
        "export const meta = { name: 'ok', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\nphase('P')\n",
    });
    expect(validateBoard(root).filter((f) => f.kind === "workflow")).toEqual([]);
  });
});
```

Add `mkdirSync`, `dirname`, `tmpdir` and `mkdtempSync` to the test file's imports if they are not already there.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @octoshell/board test -- validate`
Expected: FAIL — no workflow findings are produced.

- [ ] **Step 3: Implement `validateWorkflow`**

In `packages/board/src/validate.ts`, extend the existing `node:fs` import with `existsSync` so line 1 reads:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
```

and add a new import beside the `./managed-block.js` one:

```ts
import { parseWorkflowMeta } from "./workflow-meta.js";
```

Then add above `validateBoard`:

```ts
/**
 * Validate one workflow folder. `mdPath` is used as the finding location because it is the file a
 * human opens; script problems are reported against it too so every finding has one anchor.
 */
export function validateWorkflow(mdPath: string, jsPath: string, folderSlug: string): BoardFinding[] {
  const out: BoardFinding[] = [];
  const err = (message: string): void => {
    out.push({ mdPath, kind: "workflow", severity: "error", message });
  };

  if (!existsSync(jsPath)) {
    err("workflow.js is missing");
    return out;
  }

  let meta;
  try {
    meta = parseWorkflowMeta(readFileSync(jsPath, "utf8"));
  } catch (e) {
    err((e as Error).message);
    return out;
  }

  if (meta.name !== folderSlug) {
    err(`meta.name "${meta.name}" does not match its folder "${folderSlug}"`);
  }
  if (meta.phases.length === 0) {
    err("workflow has no phases");
    return out;
  }

  const stepPhase = new Map<string, number>();     // step id → phase index
  const parallelPhase = new Map<string, number>(); // parallel group → phase index

  meta.phases.forEach((phase, pi) => {
    if (phase.steps.length === 0) err(`phase "${phase.title}" has no steps`);
    for (const step of phase.steps) {
      if (stepPhase.has(step.id)) err(`duplicate step id "${step.id}"`);
      else stepPhase.set(step.id, pi);

      if (step.parallel !== undefined) {
        const seen = parallelPhase.get(step.parallel);
        if (seen !== undefined && seen !== pi) {
          err(`parallel group "${step.parallel}" spans more than one phase`);
        } else if (seen === undefined) {
          parallelPhase.set(step.parallel, pi);
        }
      }
    }
  });

  for (const phase of meta.phases) {
    for (const step of phase.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepPhase.has(dep)) err(`step "${step.id}" dependsOn "${dep}", which is not a step`);
      }
    }
  }

  return out;
}
```

- [ ] **Step 4: Call it from `validateBoard`**

Add a helper above `validateBoard`:

```ts
/** Validate every workflow folder under an entity, returning the count found. */
function validateWorkflowsUnder(entityDir: string, findings: BoardFinding[]): number {
  const dir = join(entityDir, "workflows");
  const slugs = safeReaddir(dir);
  for (const slug of slugs) {
    findings.push(...validateWorkflow(join(dir, slug, "workflow.md"), join(dir, slug, "workflow.js"), slug));
  }
  return slugs.length;
}
```

In `validateBoard`, after the `campaign.md` line add:

```ts
    validateWorkflowsUnder(campaignDir, findings);
```

and after the `mission.md` line add:

```ts
      const missionWorkflows = validateWorkflowsUnder(missionDir, findings);
      if (missionWorkflows > 1) {
        findings.push({
          mdPath: join(missionDir, "mission.md"),
          kind: "mission",
          severity: "error",
          message: `mission has more than one workflow (${missionWorkflows}); a mission may have at most one`,
        });
      }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @octoshell/board test -- validate`
Expected: PASS.

- [ ] **Step 6: Run the whole package and build**

Run: `pnpm --filter @octoshell/board test && pnpm --filter @octoshell/board build`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add packages/board/src/validate.ts packages/board/test/validate.test.ts
git commit -m "feat(board): validate workflow scripts and the one-per-mission rule"
```

---

### Task 7: Verify the repo and publish the new types

**Files:**
- Modify: none expected.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: `@octoshell/board`'s `dist/` carries the workflow API, ready for plan 3.

- [ ] **Step 1: Build the package so dependents see the new `.d.ts`**

Run: `pnpm --filter @octoshell/board build`
Expected: succeeds.

- [ ] **Step 2: Verify the whole repo**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(board): rebuild dist with the workflow API"
```

---

## Done when

- `new BoardModel(root).rebuild()` returns campaign and mission workflows, with `phases` from the script's `meta` and `lastRunStatus` from `## Runs`.
- A workflow whose script is missing or unparseable still appears, carrying `parseError`.
- `setWorkflowMeta` rewrites only the meta span; the script body is byte-identical.
- `validateBoard` reports every rule listed in Task 6.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` is green.
