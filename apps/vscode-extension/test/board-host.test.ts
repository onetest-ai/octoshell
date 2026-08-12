// apps/vscode-extension/test/board-host.test.ts
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardHost } from "../src/host/board-host.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function host(): { board: BoardHost; octo: string } {
  const repo = mkdtempClean("boardhost-");
  return { board: new BoardHost(join(repo, ".octobots")), octo: join(repo, ".octobots") };
}

describe("BoardHost", () => {
  it("creates a campaign+mission+task and reads them back after reconcile", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "Onboarding" });
    const m = board.createMission({ title: "Assemble", campaignId: c.id });
    const t = board.createTask({ missionId: m.id, name: "Draft" });
    expect(board.listCampaigns().map((x) => x.id)).toContain(c.id);
    expect(board.listMissions(c.id).map((x) => x.id)).toContain(m.id);
    expect(board.listTasks(m.id).map((x) => x.id)).toContain(t.id);
  });

  it("emits entities:changed on reconcile", () => {
    const { board } = host();
    let fired = 0;
    board.on("entities:changed", () => { fired++; });
    board.createCampaign({ name: "C" }); // create reconciles internally
    expect(fired).toBeGreaterThanOrEqual(1);
  });

  // The panel `load()` path calls these sync methods; emitting from there would re-trigger every
  // open panel's load() → sync → emit → load() … a tight feedback loop. They must refresh the
  // model for the subsequent read WITHOUT emitting.
  it("syncBugsFromBoard / syncMissionFromBoard do NOT emit entities:changed", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    let fired = 0;
    board.on("entities:changed", () => { fired++; });
    board.syncBugsFromBoard({ missionId: m.id });
    board.syncBugsFromBoard({ campaignId: c.id });
    board.syncMissionFromBoard(m.id);
    expect(fired).toBe(0);
  });

  it("setStatus on a task is reflected on next read", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const t = board.createTask({ missionId: m.id, name: "T" });
    // The UI passes ENTITY statuses (draft/executing/awaitingApproval/done/failed/cancelled).
    board.setStatus("task", t.id, "executing");
    expect(board.getTask(t.id)!.status).toBe("executing");
  });

  it("campaignRollup reflects mission statuses", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    board.setStatus("mission", m.id, "executing");
    expect(board.campaignRollup(c.id)!.rollupStatus).toBe("active");
  });

  it("deleteTask removes it from the board", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const t = board.createTask({ missionId: m.id, name: "T" });
    board.deleteTask(t.id);
    expect(board.listTasks(m.id).map((x) => x.id)).not.toContain(t.id);
  });

  it("createBug accepts a flat {title, campaignId|missionId} shape", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const cb = board.createBug({ title: "Campaign bug", campaignId: c.id });
    const mb = board.createBug({ title: "Mission bug", missionId: m.id });
    expect(board.listBugs({ campaignId: c.id }).map((b) => b.id)).toContain(cb.id);
    expect(board.listBugs({ missionId: m.id }).map((b) => b.id)).toContain(mb.id);
  });

  // ── Document methods ────────────────────────────────────────────────────────

  it("addCampaignLink / campaignDocs / removeCampaignLink round-trip", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const link = board.addCampaignLink(c.id, { url: "https://example.com/spec", title: "Spec" });
    expect(link.target).toBe("https://example.com/spec");
    expect(link.label).toBe("Spec");
    const docs = board.campaignDocs(c.id);
    expect(docs.links.map((l) => l.target)).toContain("https://example.com/spec");
    expect(docs.attachedFiles).toEqual([]);
    board.removeCampaignLink(c.id, "https://example.com/spec");
    const docs2 = board.campaignDocs(c.id);
    expect(docs2.links.map((l) => l.target)).not.toContain("https://example.com/spec");
  });

  it("addCampaignFile / campaignDocs round-trip", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const file = board.addCampaignFile(c.id, { path: "/repo/spec.md", label: "spec" });
    expect(file.target).toBe("/repo/spec.md");
    expect(file.label).toBe("spec");
    const docs = board.campaignDocs(c.id);
    expect(docs.attachedFiles.map((f) => f.target)).toContain("/repo/spec.md");
    expect(docs.links).toEqual([]);
  });

  it("addMissionLink / missionDocs / removeMissionLink round-trip", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const link = board.addMissionLink(m.id, { url: "https://example.com/plan", title: "Plan" });
    expect(link.target).toBe("https://example.com/plan");
    const docs = board.missionDocs(m.id);
    expect(docs.links.map((l) => l.target)).toContain("https://example.com/plan");
    board.removeMissionLink(m.id, "https://example.com/plan");
    const docs2 = board.missionDocs(m.id);
    expect(docs2.links.map((l) => l.target)).not.toContain("https://example.com/plan");
  });

  it("addMissionFile / missionDocs round-trip", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const file = board.addMissionFile(m.id, { path: "/repo/plan.md", label: "plan" });
    expect(file.target).toBe("/repo/plan.md");
    const docs = board.missionDocs(m.id);
    expect(docs.attachedFiles.map((f) => f.target)).toContain("/repo/plan.md");
  });

  it("campaignDocs.files lists on-disk files in the campaign folder (excluding the campaign.yaml entity file)", () => {
    const { board, octo } = host();
    const c = board.createCampaign({ name: "C" });
    const cFolder = c.folderPath; // e.g. "campaigns/c"
    writeFileSync(join(octo, cFolder, "notes.md"), "# Notes\n", "utf8");
    const docs = board.campaignDocs(c.id);
    expect(docs.files.map((f) => f.name)).toContain("notes.md");
    // The entity file itself is never listed as a document.
    expect(docs.files.map((f) => f.name)).not.toContain("campaign.yaml");
    expect(docs.files.map((f) => f.name)).not.toContain("campaign.md");
  });

  // ── campaignSummary ─────────────────────────────────────────────────────────

  it("campaignSummary returns null for unknown campaign", () => {
    const { board } = host();
    expect(board.campaignSummary("nonexistent")).toBeNull();
  });

  it("campaignSummary counts per-status and rolls up correctly", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m1 = board.createMission({ title: "M1", campaignId: c.id });
    const m2 = board.createMission({ title: "M2", campaignId: c.id });
    board.setStatus("mission", m1.id, "executing");
    board.setStatus("mission", m2.id, "done");

    const summary = board.campaignSummary(c.id);
    expect(summary).not.toBeNull();
    expect(summary!.counts["executing"]).toBe(1);
    expect(summary!.counts["done"]).toBe(1);
    expect(summary!.rollupStatus).toBe("active");
    expect(summary!.campaignId).toBe(c.id);
    expect(summary!.name).toBe("C");
    expect(summary!.total).toBe(2);
    expect(summary!.active).toBe(1);
    expect(summary!.completed).toBe(1);
  });

  // ── Proposal sync methods ────────────────────────────────────────────────────

  it("syncCampaignMissions returns empty proposals when the campaign description has no ## Missions section", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const result = board.syncCampaignMissions(c.id);
    expect(result.proposals).toEqual([]);
  });

  it("syncCampaignMissions reports a description-authored mission as exists:false when no folder exists", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    // The proposal list lives in the campaign's own YAML `description` prose, not a parent projection.
    board.updateBrief("campaign", c.id, { description: "## Missions\n- Pending Mission\n" });
    const result = board.syncCampaignMissions(c.id);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.title).toBe("Pending Mission");
    expect(result.proposals[0]!.exists).toBe(false);
  });

  it("syncCampaignMissions marks a mission as exists:true when folder exists", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    board.updateBrief("campaign", c.id, { description: "## Missions\n- Real Mission\n" });
    // Create the mission folder via board
    board.createMission({ title: "Real Mission", campaignId: c.id });
    // Now it is both a ## Missions proposal AND has a folder → exists:true
    const result = board.syncCampaignMissions(c.id);
    const proposal = result.proposals.find((p) => p.title === "Real Mission");
    expect(proposal?.exists).toBe(true);
  });

  it("createMissionsFromBoard materializes proposals and a re-sync shows them as exists:true", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    // Author a ## Missions bullet in the campaign description (YAML).
    board.updateBrief("campaign", c.id, { description: "## Missions\n- New Mission — do the work\n" });

    // Before creating: shows as exists:false
    const before = board.syncCampaignMissions(c.id);
    const proposal = before.proposals.find((p) => p.title === "New Mission");
    expect(proposal?.exists).toBe(false);
    expect(proposal?.description).toBe("do the work");

    // Materialize
    const created = board.createMissionsFromBoard(c.id, [{ title: "New Mission", description: "do the work" }]);
    expect(created.created).toBe(1);
    expect(board.listMissions(c.id).some((m) => m.title === "New Mission")).toBe(true);

    // After: shows as exists:true
    const after = board.syncCampaignMissions(c.id);
    const postProposal = after.proposals.find((p) => p.title === "New Mission");
    expect(postProposal?.exists).toBe(true);
  });

  it("createMissionsFromBoard skips duplicates (case-insensitive)", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    board.createMission({ title: "Alpha", campaignId: c.id });
    const result = board.createMissionsFromBoard(c.id, [{ title: "Alpha" }, { title: "alpha" }, { title: "Beta" }]);
    // Alpha is duplicate (2 forms), Beta is new
    expect(result.created).toBe(1);
    expect(board.listMissions(c.id).filter((m) => m.title === "Beta")).toHaveLength(1);
  });

  it("syncMissionFromBoard reconciles and returns { created: 0 }", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const result = board.syncMissionFromBoard(m.id);
    expect(result).toEqual({ created: 0 });
    // Board still contains the mission after reconcile
    expect(board.getMission(m.id)).not.toBeNull();
  });

  it("syncBugsFromBoard reconciles and returns { created: 0 }", () => {
    const { board } = host();
    const c = board.createCampaign({ name: "C" });
    const m = board.createMission({ title: "M", campaignId: c.id });
    const r1 = board.syncBugsFromBoard({ campaignId: c.id });
    const r2 = board.syncBugsFromBoard({ missionId: m.id });
    expect(r1).toEqual({ created: 0 });
    expect(r2).toEqual({ created: 0 });
  });
});
