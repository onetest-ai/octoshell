import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManagedBlock } from "@octoshell/board";
import { BoardHost } from "../src/host/board-host.js";
import { dispatch, type DispatchCtx } from "../src/host/rpc-dispatcher.js";
import type { Report } from "@octoshell/tokenomics";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tok-rpc-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeBrief(kind: "campaign" | "mission", dir: string, fields: Record<string, unknown>, tail = "") {
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeFileSync(join(dir, `${kind}.md`), renderManagedBlock(kind, fields as any, [], "planner") + tail, "utf8");
}

function transcript(branch: string): void {
  const proj = join(root, ".claude", "projects", "p");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "sess-1.jsonl"),
    JSON.stringify({
      type: "assistant",
      gitBranch: branch,
      requestId: "r1",
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 5000 },
        content: [],
      },
    }) + "\n",
  );
}

function ctx(): DispatchCtx {
  const board = new BoardHost(join(root, ".octobots"));
  return {
    board,
    workspaceFolderPath: root,
    // Unused by this route; the dispatcher only touches board + workspace path.
  } as unknown as DispatchCtx;
}

describe("tokenomics:report", () => {
  it("returns a priced report attributed to the board's mission", async () => {
    const c = join(root, ".octobots", "campaigns", "demo");
    writeBrief("campaign", c, { name: "Demo", description: "", acceptanceCriteria: "", status: "draft", target: "" });
    writeBrief("mission", join(c, "missions", "m1"),
      { name: "M1 - Demo", description: "d", acceptanceCriteria: "- [ ] ac" },
      "\n## Tokenomics\neffort_days: 2\nsize_tshirt: M\n");
    transcript("feat/demo-m1");

    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.agentTool).toBe("claude-code");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]!.missionTitle).toBe("M1 - Demo");
    expect(report.runs[0]!.estimate).toMatchObject({ effortDays: 2, sizeTshirt: "M" });
    expect(report.runs[0]!.costUsd).toBeGreaterThan(0);
  });

  it("returns an empty report rather than throwing when nothing has been measured", async () => {
    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.runs).toEqual([]);
    expect(report.unattributed.segments).toBe(0);
  });

  it("reports off-board work as unattributed instead of dropping it", async () => {
    const c = join(root, ".octobots", "campaigns", "demo");
    writeBrief("campaign", c, { name: "Demo", description: "", acceptanceCriteria: "", status: "draft", target: "" });
    transcript("main");
    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.runs).toEqual([]);
    expect(report.unattributed.branches).toEqual(["main"]);
    expect(report.unattributed.costUsd).toBeGreaterThan(0);
  });
});
