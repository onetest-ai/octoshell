import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BoardHost } from "../src/host/board-host.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function host(): { board: BoardHost; campaignId: string; missionId: string } {
  const root = mkdtempClean("host-wf-");
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
    board.setWorkflowMeta(id, {
      name: "build",
      description: "d",
      phases: [{ title: "Run", steps: [{ id: "s1", agent: "claude", label: "Build" }] }],
    });
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
