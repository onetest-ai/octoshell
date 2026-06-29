import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/host/rpc-dispatcher.js";
import { BoardHost } from "../src/host/board-host.js";
import { TeamAssignments } from "../src/host/team-assignments.js";
import { AppearanceStore } from "../src/host/appearance-store.js";
import { CustomizationsIo } from "../src/host/customizations-io.js";
import { FakeMemento } from "./helpers.js";

/** Returns a fresh BoardHost backed by a temp dir, plus the workspace root for that temp dir. */
function makeBoardWithRoot(): { board: BoardHost; repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "rpc-test-"));
  return { board: new BoardHost(join(repoRoot, ".octobots")), repoRoot };
}

/** Returns just the BoardHost (tests that don't need the repoRoot). */
function makeBoard(): BoardHost {
  return makeBoardWithRoot().board;
}

function makeTeamAssignments() {
  return new TeamAssignments(new FakeMemento());
}

function ctx(board?: BoardHost) {
  const { board: defaultBoard, repoRoot } = makeBoardWithRoot();
  const b = board ?? defaultBoard;
  const teamAssignments = makeTeamAssignments();
  const appearanceStore = new AppearanceStore(new FakeMemento());
  const customizationsIo = new CustomizationsIo(repoRoot);
  return { board: b, teamAssignments, appearanceStore, customizationsIo, workspaceFolderPath: repoRoot, dialog: { openFiles: async () => ["x"] }, editor: { openReadonly: async () => {} } };
}

describe("dispatch", () => {
  it("routes project:list to workspace folder (no appRuntime)", async () => {
    const c = ctx();
    const res = await dispatch("project:list", {}, c as never);
    // Returns the single workspace project; id is always "workspace"
    const list = res as Array<{ id: string; name: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("workspace");
  });

  it("routes campaign:list to board.listCampaigns", async () => {
    const b = makeBoard();
    b.createCampaign({ name: "Default" });
    const c = ctx(b);
    const res = await dispatch("campaign:list", { projectId: "p1" }, c as never);
    expect((res as Array<{ name: string }>).some((x) => x.name === "Default")).toBe(true);
  });

  it("routes campaign:create to board.createCampaign", async () => {
    const c = ctx();
    const res = await dispatch("campaign:create", { projectId: "p1", name: "Q3" }, c as never);
    expect((res as { name: string }).name).toBe("Q3");
    // entity exists on the board
    expect(c.board.listCampaigns().some((x) => x.name === "Q3")).toBe(true);
  });

  it("routes campaign:get to board.getCampaign + board.campaignSummary", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "Q4" });
    const m = b.createMission({ title: "M", campaignId: camp.id });
    b.setStatus("mission", m.id, "executing");
    const c = ctx(b);
    const res = await dispatch("campaign:get", { projectId: "p1", campaignId: camp.id }, c as never);
    const typed = res as { campaign: { id: string; name: string }; summary: { rollupStatus: string; counts: Record<string, number> } };
    expect(typed.campaign.id).toBe(camp.id);
    expect(typed.campaign.name).toBe("Q4");
    expect(typed.summary.rollupStatus).toBe("active");
    expect(typed.summary.counts["executing"]).toBe(1);
  });

  it("routes campaign:update to board.updateBrief", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "Q3" });
    const c = ctx(b);
    await dispatch("campaign:update", { projectId: "p1", campaignId: camp.id, target: "T" }, c as never);
    expect(c.board.getCampaign(camp.id)?.target).toBe("T");
  });

  it("routes campaign:docs, addLink, removeLink to board (not daemon)", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const c = ctx(b);
    const docs = await dispatch("campaign:docs", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((docs as { links: unknown[] }).links).toEqual([]);
    await dispatch("campaign:docs:createFile", { projectId: "p1", campaignId: camp.id, name: "brief" }, c as never);
    const link = await dispatch("campaign:docs:addLink", { projectId: "p1", campaignId: camp.id, url: "https://y", title: "Y" }, c as never);
    expect((link as { target: string }).target).toBe("https://y");
    const docs2 = await dispatch("campaign:docs", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((docs2 as { links: Array<{ target: string }> }).links.map((l) => l.target)).toContain("https://y");
    await dispatch("campaign:docs:removeLink", { projectId: "p1", campaignId: camp.id, target: "https://y" }, c as never);
    const docs3 = await dispatch("campaign:docs", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((docs3 as { links: Array<{ target: string }> }).links.map((l) => l.target)).not.toContain("https://y");
  });

  it("routes mission:docs, addLink, removeLink, addFile to board (not daemon)", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const c = ctx(b);
    const link = await dispatch("mission:docs:addLink", { projectId: "p1", missionId: mission.id, url: "https://plan.md", title: "Plan" }, c as never);
    expect((link as { target: string }).target).toBe("https://plan.md");
    const docs = await dispatch("mission:docs", { projectId: "p1", missionId: mission.id }, c as never);
    expect((docs as { links: Array<{ target: string }> }).links.map((l) => l.target)).toContain("https://plan.md");
    await dispatch("mission:docs:removeLink", { projectId: "p1", missionId: mission.id, target: "https://plan.md" }, c as never);
    const docs2 = await dispatch("mission:docs", { projectId: "p1", missionId: mission.id }, c as never);
    expect((docs2 as { links: Array<{ target: string }> }).links.map((l) => l.target)).not.toContain("https://plan.md");
    const file = await dispatch("mission:docs:addFile", { projectId: "p1", missionId: mission.id, path: "/repo/spec.md", label: "spec" }, c as never);
    expect((file as { target: string }).target).toBe("/repo/spec.md");
  });

  it("routes mission:list to board.listMissions", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    b.createMission({ title: "Draft", campaignId: camp.id });
    const c = ctx(b);
    const res = await dispatch("mission:list", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((res as Array<{ title: string }>).some((x) => x.title === "Draft")).toBe(true);
  });

  it("routes mission:get to board.getMission", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "Draft", campaignId: camp.id });
    const c = ctx(b);
    const res = await dispatch("mission:get", { projectId: "p1", missionId: mission.id }, c as never);
    expect((res as { id: string } | null)?.id).toBe(mission.id);
  });

  it("routes campaign:docs:addFile to board.addCampaignFile", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const c = ctx(b);
    const res = await dispatch("campaign:docs:addFile", { projectId: "p1", campaignId: camp.id, path: "/repo/spec.md", label: "spec.md" }, c as never);
    expect((res as { kind: string }).kind).toBe("file");
    expect((res as { target: string }).target).toBe("/repo/spec.md");
    // file appears in docs
    const docs = await dispatch("campaign:docs", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((docs as { attachedFiles: Array<{ target: string }> }).attachedFiles.map((f) => f.target)).toContain("/repo/spec.md");
  });

  it("routes campaign:missions:sync and :create to board (not daemon)", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const c = ctx(b);
    // Before creating: sync shows no proposals (no ## Missions lines in campaign.md yet)
    const sync0 = await dispatch("campaign:missions:sync", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((sync0 as { proposals: unknown[] }).proposals).toEqual([]);
    // createMissionsFromBoard creates a mission and reconciles
    const result = await dispatch("campaign:missions:create", { projectId: "p1", campaignId: camp.id, missions: [{ title: "Alpha" }] }, c as never);
    expect((result as { created: number }).created).toBe(1);
    expect(c.board.listMissions(camp.id).some((m) => m.title === "Alpha")).toBe(true);
    // Re-sync: Alpha now exists
    const sync1 = await dispatch("campaign:missions:sync", { projectId: "p1", campaignId: camp.id }, c as never);
    const proposals = (sync1 as { proposals: Array<{ title: string; exists: boolean }> }).proposals;
    const alpha = proposals.find((p) => p.title === "Alpha");
    expect(alpha?.exists).toBe(true);
  });

  it("routes campaign:delete and mission:delete to the board", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const c = ctx(b);
    await dispatch("campaign:delete", { projectId: "p1", campaignId: camp.id }, c as never);
    await dispatch("mission:delete", { projectId: "p1", missionId: mission.id }, c as never);
    // entities are actually gone from the board
    expect(c.board.listCampaigns().some((x) => x.id === camp.id)).toBe(false);
    expect(c.board.listMissions(camp.id).some((x) => x.id === mission.id)).toBe(false);
  });

  it("routes mission:update to board", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const c = ctx(b);
    await dispatch("mission:update", { projectId: "p1", missionId: mission.id, description: "d" }, c as never);
    expect(c.board.getMission(mission.id)?.description).toBe("d");
  });

  it("routes task:get / task:list / task:create to board", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const task = b.createTask({ missionId: mission.id, name: "T" });
    const c = ctx(b);
    const got = await dispatch("task:get", { projectId: "p1", taskId: task.id }, c as never);
    expect((got as { id: string } | null)?.id).toBe(task.id);
    const list = await dispatch("task:list", { projectId: "p1", missionId: mission.id }, c as never);
    expect((list as Array<{ id: string }>).some((x) => x.id === task.id)).toBe(true);
    const created = await dispatch("task:create", { projectId: "p1", missionId: mission.id, name: "T2" }, c as never);
    expect((created as { name: string }).name).toBe("T2");
  });

  it("task:setStatus persists and returns ok", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const task = b.createTask({ missionId: mission.id, name: "T" });
    const c = ctx(b);
    const res = await dispatch("task:setStatus", { projectId: "p1", taskId: task.id, status: "executing" }, c as never);
    expect(res).toEqual({ ok: true });
    const got = await dispatch("task:get", { projectId: "p1", taskId: task.id }, c as never);
    expect((got as { status: string }).status).toBe("executing");
  });

  it("mission:setStatus throws (not silent ok) when the entity can't be found", async () => {
    const c = ctx();
    await expect(
      dispatch("mission:setStatus", { projectId: "p1", missionId: "nope", status: "executing" }, c as never),
    ).rejects.toThrow(/could not set status/i);
  });

  it("routes task:update and task:delete to board", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const task = b.createTask({ missionId: mission.id, name: "T" });
    const c = ctx(b);
    await dispatch("task:update", { projectId: "p1", taskId: task.id, description: "d" }, c as never);
    await dispatch("task:delete", { projectId: "p1", taskId: task.id }, c as never);
  });

  it("routes bug:get / bug:list / bug:create to board (campaign + mission parents)", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const campBug = b.createBug({ title: "CB", campaignId: camp.id });
    const missionBug = b.createBug({ title: "MB", missionId: mission.id });
    const c = ctx(b);
    const got = await dispatch("bug:get", { projectId: "p1", bugId: campBug.id }, c as never);
    expect((got as { id: string } | null)?.id).toBe(campBug.id);
    const mList = await dispatch("bug:list", { projectId: "p1", missionId: mission.id }, c as never);
    expect((mList as Array<{ id: string }>).some((x) => x.id === missionBug.id)).toBe(true);
    const cList = await dispatch("bug:list", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((cList as Array<{ id: string }>).some((x) => x.id === campBug.id)).toBe(true);
    const created = await dispatch("bug:create", { projectId: "p1", title: "B", missionId: mission.id, severity: "blocker" }, c as never);
    expect((created as { title: string }).title).toBe("B");
  });

  it("routes bug:update and bug:delete to board", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const bug = b.createBug({ title: "B", campaignId: camp.id });
    const c = ctx(b);
    await dispatch("bug:update", { projectId: "p1", bugId: bug.id, rca: "root cause" }, c as never);
    await dispatch("bug:delete", { projectId: "p1", bugId: bug.id }, c as never);
  });

  it("routes bug:sync to board", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const c = ctx(b);
    // bug:sync → board (not daemon)
    const syncResult = await dispatch("bug:sync", { projectId: "p1", missionId: mission.id }, c as never);
    expect((syncResult as { created: number }).created).toBe(0);
    // campaign-scoped sync also works
    const syncCamp = await dispatch("bug:sync", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((syncCamp as { created: number }).created).toBe(0);
  });

  it("routes team:assign / team:assignments to globalState (not daemon)", async () => {
    const c = ctx();
    await dispatch("team:assign", { projectId: "p1", scope: "campaign", scopeId: "camp1", workType: "bug", teamId: "t1" }, c as never);
    const assignments = await dispatch("team:assignments", { projectId: "p1" }, c as never);
    // assignment is stored and retrievable
    expect(assignments).toContainEqual({ scope: "campaign", scopeId: "camp1", workType: "bug", teamId: "t1" });
  });

  it("routes teams:list to board (not daemon)", async () => {
    const c = ctx();
    const res = await dispatch("teams:list", { projectId: "p1" }, c as never);
    // board.listTeams() returns an array (empty — no teams/*.json in the temp dir)
    expect(Array.isArray(res)).toBe(true);
  });

  it("routes campaign:setTeam and mission:setTeam to board (disk markers)", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const mission = b.createMission({ title: "M", campaignId: camp.id });
    const c = ctx(b);
    const res1 = await dispatch("campaign:setTeam", { projectId: "p1", campaignId: camp.id, teamId: "team-eng" }, c as never);
    const res2 = await dispatch("mission:setTeam", { projectId: "p1", missionId: mission.id, teamId: "team-cop" }, c as never);
    expect(res1).toEqual({ ok: true });
    expect(res2).toEqual({ ok: true });
    // board has the team set via disk markers
    expect(b.getTeam("campaign", camp.id)).toBe("team-eng");
    expect(b.getTeam("mission", mission.id)).toBe("team-cop");
  });

  it("routes team:getBinding and team:setBinding to board (disk markers)", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "C" });
    const c = ctx(b);
    // Initially null
    const before = await dispatch("team:getBinding", { projectId: "p1", scope: "campaign", scopeId: camp.id }, c as never);
    expect(before).toBeNull();
    // Set the binding
    const setRes = await dispatch("team:setBinding", { projectId: "p1", binding: { scope: "campaign", scopeId: camp.id, teamId: "team-x" } }, c as never);
    expect(setRes).toEqual({ ok: true });
    // Get it back
    const after = await dispatch("team:getBinding", { projectId: "p1", scope: "campaign", scopeId: camp.id }, c as never);
    expect((after as { teamId: string | null } | null)?.teamId).toBe("team-x");
  });

  it("throws on unknown method", async () => {
    const c = ctx();
    await expect(dispatch("nope:nope", {}, c as never)).rejects.toThrow(/unknown method/i);
  });

  it("rejects malformed args via Zod (handler never runs)", async () => {
    const c = ctx();
    // campaign:setTeam requires campaignId to be a string; passing a number must fail Zod validation
    await expect(dispatch("campaign:setTeam", { campaignId: 123, teamId: null }, c as never)).rejects.toThrow();
  });
});
