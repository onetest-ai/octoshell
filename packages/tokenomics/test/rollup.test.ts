import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardModel, renderManagedBlock } from "@octoshell/board";
import { rollup } from "../src/rollup.js";
import { emptyTotals, type Segment, type TranscriptSource } from "../src/types.js";
import type { PriceTable } from "../src/prices.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tok-rollup-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PRICES: PriceTable = {
  fetched_at: "2026-07-22",
  models: {
    cheap: { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6, cache_read_input_token_cost: 1e-6 },
    dear: { input_cost_per_token: 10e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 10e-6 },
  },
};

function writeBrief(kind: "campaign" | "mission" | "task", dir: string, fields: Record<string, unknown>, tail = "") {
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeFileSync(join(dir, `${kind}.md`), renderManagedBlock(kind, fields as any, [], "planner") + tail, "utf8");
}

/** campaign `demo` / mission `M1` / tasks T1.1 + T1.2, with estimates. */
function board(): BoardModel {
  const c = join(root, "campaigns", "demo");
  writeBrief("campaign", c, { name: "Demo", description: "", acceptanceCriteria: "", status: "draft", target: "" });
  const m = join(c, "missions", "m1");
  writeBrief("mission", m, { name: "M1 - Demo mission", description: "d", acceptanceCriteria: "- [ ] ac" },
    "\n## Tokenomics\neffort_days: 4\nsize_tshirt: L\n");
  writeBrief("task", join(m, "tasks", "t1"), { name: "T1.1 - First", description: "", acceptanceCriteria: "- [ ] ac" },
    "\n## Tokenomics\neffort_days: 2\nsize_tshirt: M\n");
  writeBrief("task", join(m, "tasks", "t2"), { name: "T1.2 - Second", description: "", acceptanceCriteria: "- [ ] ac" });
  const b = new BoardModel(root);
  b.rebuild();
  return b;
}

function seg(over: Partial<Segment> & { segmentId: string; branch: string }): Segment {
  return {
    sessionId: "sess-1", kind: "orchestrator", agentType: null, workflowId: null,
    startedAt: null, endedAt: null, turns: 1, tools: {},
    tokensByModel: { cheap: { ...emptyTotals(), output: 1_000_000 } },
    ...over,
  };
}

const source = (segments: Segment[]): TranscriptSource => ({ agentTool: "test", collect: () => segments });

const run = (segments: Segment[]) =>
  rollup({ repoRoot: root, artifactsRoot: root, board: board(), source: source(segments), prices: PRICES, now: () => new Date(0) });

describe("rollup", () => {
  it("attributes a branch to its mission and carries the authored estimate", () => {
    const r = run([seg({ segmentId: "a", branch: "feat/demo-m1-t1" })]);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.missionTitle).toBe("M1 - Demo mission");
    expect(r.runs[0]!.estimate).toMatchObject({ effortDays: 4, sizeTshirt: "L" });
    expect(r.runs[0]!.costUsd).toBe(1);
  });

  it("buckets work that maps to no mission instead of dropping it", () => {
    const r = run([seg({ segmentId: "a", branch: "main" })]);
    expect(r.runs).toHaveLength(0);
    expect(r.unattributed).toMatchObject({ segments: 1, branches: ["main"], costUsd: 1 });
  });

  it("splits tasks by branch and reports the inference", () => {
    const r = run([
      seg({ segmentId: "a", branch: "feat/demo-m1-t1" }),
      seg({ segmentId: "b", branch: "feat/demo-m1-t2" }),
    ]);
    const tasks = r.runs[0]!.tasks;
    expect(tasks.find((t) => t.taskId === "T1.1")?.attribution).toBe("branch-inference");
    expect(tasks.find((t) => t.taskId === "T1.2")).toBeTruthy();
  });

  // A recorded fact beats a branch guess — this is the whole point of the hook.
  it("prefers the work log over branch inference", () => {
    mkdirSync(join(root, ".octobots", "tokenomics"), { recursive: true });
    appendFileSync(
      join(root, ".octobots", "tokenomics", "worklog.jsonl"),
      JSON.stringify({ session_id: "sess-1", task: "T1.2", state: "active", branch: "spike/odd" }) + "\n",
    );
    const r = run([seg({ segmentId: "a", branch: "spike/odd", sessionId: "sess-1" })]);
    // The branch says nothing; the work log says T1.2.
    const t = r.runs[0]!.tasks.find((x) => x.taskId === "T1.2");
    expect(t?.attribution).toBe("worklog");
    expect(t?.costUsd).toBe(1);
  });

  it("reports a declared-but-unmeasured task at zero rather than omitting it", () => {
    const r = run([seg({ segmentId: "a", branch: "feat/demo-m1-t1" })]);
    const t2 = r.runs[0]!.tasks.find((t) => t.taskId === "T1.2");
    expect(t2).toMatchObject({ unmeasured: true, costUsd: 0 });
    expect(t2!.name).toContain("Second");
  });

  it("keeps mission-branch work in a mission-level bucket, not on an arbitrary task", () => {
    const r = run([seg({ segmentId: "a", branch: "feat/demo-m1" })]);
    const bucket = r.runs[0]!.tasks.find((t) => t.taskId === null);
    expect(bucket?.name).toMatch(/Mission-level/);
  });

  it("prices each model at its own rate rather than by token share", () => {
    const r = run([
      seg({
        segmentId: "a", branch: "feat/demo-m1-t1",
        tokensByModel: {
          cheap: { ...emptyTotals(), output: 1_000_000 },
          dear: { ...emptyTotals(), output: 1_000_000 },
        },
      }),
    ]);
    // Equal tokens, 10x price difference — an equal split would report 50/50.
    expect(r.runs[0]!.costByModel).toEqual({ cheap: 1, dear: 10 });
  });

  it("computes the orchestrator/subagent split from real segment kinds", () => {
    const r = run([
      seg({ segmentId: "a", branch: "feat/demo-m1-t1" }),
      seg({ segmentId: "b", branch: "feat/demo-m1-t1", kind: "subagent", agentType: "python-dev" }),
    ]);
    expect(r.runs[0]!.subagentDispatches).toBe(1);
    expect(r.runs[0]!.orchestratorCostPct).toBe(50);
  });

  it("surfaces models it could not price instead of silently costing them at zero", () => {
    const r = run([
      seg({ segmentId: "a", branch: "feat/demo-m1-t1", tokensByModel: { mystery: { ...emptyTotals(), output: 1e6 } } }),
    ]);
    expect(r.unpricedModels).toEqual(["mystery"]);
    expect(r.runs[0]!.costUsd).toBe(0);
  });
});
