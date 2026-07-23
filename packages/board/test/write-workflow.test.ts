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
