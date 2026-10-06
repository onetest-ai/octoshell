import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateBrief } from "@octoshell/board";
import { dispatch } from "../src/host/rpc-dispatcher.js";
import { BoardHost } from "../src/host/board-host.js";
import { AppearanceStore } from "../src/host/appearance-store.js";
import { FakeMemento } from "./helpers.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** Returns a fresh BoardHost backed by a temp dir, plus the workspace root for that temp dir. */
function makeBoardWithRoot(): { board: BoardHost; repoRoot: string } {
  const repoRoot = mkdtempClean("rpc-test-");
  return { board: new BoardHost(join(repoRoot, ".octobots")), repoRoot };
}

/** Returns just the BoardHost (tests that don't need the repoRoot). */
function makeBoard(): BoardHost {
  return makeBoardWithRoot().board;
}

function ctx(board?: BoardHost, confirm: (message: string, actionLabel: string) => Promise<boolean> = async () => false) {
  const { board: defaultBoard, repoRoot } = makeBoardWithRoot();
  const b = board ?? defaultBoard;
  const appearanceStore = new AppearanceStore(new FakeMemento());
  return { board: b, appearanceStore, workspaceFolderPath: repoRoot, dialog: { openFiles: async () => ["x"], confirm }, editor: { openReadonly: async () => {}, openFile: async () => {} } };
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
    b.setStatus("mission", m.id, "executing", { force: "test" });
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

  it("routes notes through <kind>:update for every entity kind", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "Q3" });
    const mission = b.createMission({ campaignId: camp.id, title: "M1 - Auth" });
    const task = b.createTask({ missionId: mission.id, name: "T1.1 - JWT" });
    const bug = b.createBug({ campaignId: camp.id, title: "B1 - Broken" });
    const c = ctx(b);

    await dispatch("campaign:update", { projectId: "p1", campaignId: camp.id, notes: "## C\ncampaign" }, c as never);
    await dispatch("mission:update", { projectId: "p1", missionId: mission.id, notes: "## M\nmission" }, c as never);
    await dispatch("task:update", { projectId: "p1", taskId: task.id, notes: "## T\ntask" }, c as never);
    await dispatch("bug:update", { projectId: "p1", bugId: bug.id, notes: "## B\nbug" }, c as never);

    expect(c.board.getCampaign(camp.id)?.notes).toBe("## C\ncampaign");
    expect(c.board.getMission(mission.id)?.notes).toBe("## M\nmission");
    expect(c.board.getTask(task.id)?.notes).toBe("## T\ntask");
    expect(c.board.getBug(bug.id)?.notes).toBe("## B\nbug");
  });

  it("leaves notes alone when <kind>:update omits them", async () => {
    const b = makeBoard();
    const camp = b.createCampaign({ name: "Q3" });
    const c = ctx(b);
    await dispatch("campaign:update", { projectId: "p1", campaignId: camp.id, notes: "keep me" }, c as never);

    await dispatch("campaign:update", { projectId: "p1", campaignId: camp.id, description: "d" }, c as never);

    expect(c.board.getCampaign(camp.id)?.notes).toBe("keep me");
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
    // Before authoring: sync shows no proposals (campaign description has no ## Missions section).
    const sync0 = await dispatch("campaign:missions:sync", { projectId: "p1", campaignId: camp.id }, c as never);
    expect((sync0 as { proposals: unknown[] }).proposals).toEqual([]);
    // Author a ## Missions list into the campaign description (campaign.yaml), then materialize it.
    await dispatch("campaign:update", { projectId: "p1", campaignId: camp.id, description: "## Missions\n- Alpha\n" }, c as never);
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

  it("throws on unknown method", async () => {
    const c = ctx();
    await expect(dispatch("nope:nope", {}, c as never)).rejects.toThrow(/unknown method/i);
  });

  it("rejects malformed args via Zod (handler never runs)", async () => {
    const c = ctx();
    // campaign:setStatus requires campaignId to be a string; passing a number must fail Zod validation
    await expect(dispatch("campaign:setStatus", { campaignId: 123, status: "draft" }, c as never)).rejects.toThrow();
  });
});

// ── mission:setStatus plan-review confirm (mission M5 AC2) ───────────────────────────────────────

const STRICT = "## Plan review (ba + tech-lead, 2026-10-05)\nReviewers: ba (Alex), tech-lead (Rio)\nVerdict: approved";
const LEGACY = "## Plan review (Alex + Rio, 2026-10-02)\nLooked fine.";

function missionFixture(notes?: { mission?: string; campaign?: string }) {
  const { board, repoRoot } = makeBoardWithRoot();
  const camp = board.createCampaign({ name: "C" });
  if (notes?.campaign !== undefined) board.updateBrief("campaign", camp.id, { notes: notes.campaign });
  const m = board.createMission({ title: "M1 - Thing", campaignId: camp.id });
  if (notes?.mission !== undefined) board.updateBrief("mission", m.id, { notes: notes.mission });
  const file = join(repoRoot, ".octobots", m.folderPath, "mission.yaml");
  return { board, m, file };
}

describe("mission:setStatus with a plan-review confirm", () => {
  it("Cancel leaves the YAML byte-identical and returns the stored status; the modal names the missing review", async () => {
    const { board, m, file } = missionFixture({ mission: "## Plan review (Alex, 2026-10-05)\nonly one" });
    const before = readFileSync(file, "utf8");
    const confirm = vi.fn(async () => false);
    const res = await dispatch("mission:setStatus", { missionId: m.id, status: "active" }, ctx(board, confirm) as never);
    expect(res).toEqual({ ok: true, status: "draft" });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(confirm).toHaveBeenCalledTimes(1);
    const [message, label] = confirm.mock.calls[0] as unknown as [string, string];
    expect(message).toContain("## Plan review (Alex, 2026-10-05)");
    expect(message).toContain("heading does not name the tech-lead");
    expect(message).toContain("Reviewers: ba (<name>), tech-lead (<name>)");
    expect(message.split("\n")[0]).toContain("a plan review is recorded but does not approve the start");
    expect(message).toContain("\n--- record template (paste into the mission or campaign notes) ---\n## Plan review (<names or roles>, <date>)\nReviewers:");
    expect(label).toBeTruthy();
  });

  it("Cancel leaves a hand-written mission.yaml byte-identical (a canonical rewrite would be visible)", async () => {
    const { board, m, file } = missionFixture();
    const hand = '# written by an agent\nname: "M1 - Thing"\nstatus: draft   # not started\nnotes: |\n  Prose only.\n';
    writeFileSync(file, hand, "utf8");
    const confirm = vi.fn(async () => false);
    const res = await dispatch("mission:setStatus", { missionId: m.id, status: "executing" }, ctx(board, confirm) as never);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true });
    expect(readFileSync(file, "utf8")).toBe(hand);
  });

  it("Confirm re-reads the file: notes written to disk while the modal was open are kept, not overwritten", async () => {
    const { board, m, file } = missionFixture({ mission: "Before." });
    const confirm = vi.fn(async () => {
      // an agent edits the notes on disk while the user looks at the modal
      writeFileSync(file, readFileSync(file, "utf8").replace("Before.", "Edited during the modal."), "utf8");
      return true;
    });
    await dispatch("mission:setStatus", { missionId: m.id, status: "executing" }, ctx(board, confirm) as never);
    const notes = board.getMission(m.id)!.notes ?? "";
    expect(notes).toMatch(/^Edited during the modal\.\n\n## Plan review overridden \(/);
    expect(board.getMission(m.id)!.status).toBe("executing");
  });

  it("Confirm after a review was recorded on disk while the modal was open flips with no override note", async () => {
    const { board, m, file } = missionFixture({ mission: "Before." });
    const confirm = vi.fn(async () => {
      // an agent records a review on disk (library write, no host reconcile) while the modal is open
      updateBrief(join(file, "..", "..", "..", "..", ".."), "mission", m.id, { notes: `Before.\n\n${STRICT}` });
      return true;
    });
    await dispatch("mission:setStatus", { missionId: m.id, status: "executing" }, ctx(board, confirm) as never);
    expect(board.getMission(m.id)!.status).toBe("executing");
    expect(board.getMission(m.id)!.notes ?? "").not.toContain("overridden");
  });

  it("Confirm flips the status and appends the overridden note with the dropdown reason", async () => {
    const { board, m } = missionFixture({ mission: "Existing." });
    const confirm = vi.fn(async () => true);
    const res = await dispatch("mission:setStatus", { missionId: m.id, status: "executing" }, ctx(board, confirm) as never);
    expect(res).toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    const day = new Date().toISOString().slice(0, 10);
    expect(board.getMission(m.id)!.status).toBe("executing");
    expect(board.getMission(m.id)!.notes).toBe(`Existing.\n\n## Plan review overridden (${day})\nconfirmed in the extension's status dropdown`);
  });

  it("never calls confirm for a strict review, a legacy review, or a move that is not into executing", async () => {
    const confirm = vi.fn(async () => true);
    const strict = missionFixture({ mission: STRICT });
    expect(await dispatch("mission:setStatus", { missionId: strict.m.id, status: "executing" }, ctx(strict.board, confirm) as never)).toEqual({ ok: true });
    const legacy = missionFixture({ campaign: LEGACY });
    expect(await dispatch("mission:setStatus", { missionId: legacy.m.id, status: "active" }, ctx(legacy.board, confirm) as never)).toEqual({ ok: true });
    expect(legacy.board.getMission(legacy.m.id)!.notes ?? "").toBe("");
    for (const to of ["done", "awaitingApproval", "failed", "cancelled"]) {
      const plain = missionFixture();
      expect(await dispatch("mission:setStatus", { missionId: plain.m.id, status: to }, ctx(plain.board, confirm) as never)).toEqual({ ok: true });
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it("campaign, task and bug status changes never ask", async () => {
    const confirm = vi.fn(async () => true);
    const { board, m } = missionFixture();
    const t = board.createTask({ missionId: m.id, name: "T" });
    const camp = board.listCampaigns()[0]!;
    const c = ctx(board, confirm);
    expect(await dispatch("campaign:setStatus", { campaignId: camp.id, status: "executing" }, c as never)).toEqual({ ok: true });
    expect(await dispatch("task:setStatus", { taskId: t.id, status: "executing" }, c as never)).toEqual({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
  });
});


// ── tests:* (M6 T6.3) ────────────────────────────────────────────────────────────────────────────

describe("tests:* routes", () => {
  function testsFixture() {
    const { board, repoRoot } = makeBoardWithRoot();
    const camp = board.createCampaign({ name: "C" });
    const m1 = board.createMission({ title: "M1 - Thing", campaignId: camp.id });
    const m2 = board.createMission({ title: "M2 - Other", campaignId: camp.id });
    board.updateBrief("mission", m1.id, { acceptanceCriteria: "- [ ] first\n- [ ] second" });
    const dir = join(repoRoot, ".octobots", camp.folderPath, "tests");
    const put = (folder: string, id: string, status: string, covers: string) => {
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(join(dir, folder, `${id}_x.md`), `---\nid: ${id}\ntitle: t ${id}\nmission: ${folder.toUpperCase()}\ncovers: [${covers}]\nkind: unit\nstatus: ${status}\n---\n\n# ${id}\n`);
    };
    put("m1", "TC-001", "pass", "M1-AC1");
    put("m1", "TC-002", "fail", "M1-AC1");
    put("m2", "TC-001", "blocked", "M2-AC1");
    board.reconcile();
    return { board, camp, m1, m2, dir };
  }

  it("routes tests:list to board.listTests, whole campaign or one mission", async () => {
    const { board, camp } = testsFixture();
    const all = (await dispatch("tests:list", { campaignId: camp.id }, ctx(board) as never)) as Array<{ id: string; mission: string; status: string }>;
    expect(all.map((t) => `${t.mission}/${t.id}/${t.status}`)).toEqual(["M1/TC-001/pass", "M1/TC-002/fail", "M2/TC-001/blocked"]);
    const one = (await dispatch("tests:list", { campaignId: camp.id, mission: "M2" }, ctx(board) as never)) as unknown[];
    expect(one).toHaveLength(1);
  });

  it("routes tests:coverage to board.testCoverage", async () => {
    const { board, m1 } = testsFixture();
    const cov = (await dispatch("tests:coverage", { missionId: m1.id }, ctx(board) as never)) as { mission: string; acs: Array<{ ac: string; tcs: string[]; covered: boolean }>; uncovered: string[] };
    expect(cov.mission).toBe("M1");
    expect(cov.acs.map((a) => [a.ac, a.tcs, a.covered])).toEqual([["M1-AC1", ["TC-001", "TC-002"], true], ["M1-AC2", [], false]]);
    expect(cov.uncovered).toEqual(["M1-AC2"]);
  });

  it("routes tests:summary to board.testSummary, null for an unknown campaign", async () => {
    const { board, camp } = testsFixture();
    const s = (await dispatch("tests:summary", { campaignId: camp.id }, ctx(board) as never)) as { total: number; counts: Record<string, number>; uncovered: number };
    expect(s.total).toBe(3);
    expect(s.counts).toMatchObject({ pass: 1, fail: 1, blocked: 1, unknown: 0 });
    expect(s.uncovered).toBe(1);
    expect(await dispatch("tests:summary", { campaignId: "nope" }, ctx(board) as never)).toBeNull();
  });

  it("rejects malformed ids and mission tokens before any handler runs", async () => {
    const { board, camp } = testsFixture();
    const spy = vi.spyOn(board, "listTests");
    for (const args of [{ campaignId: "" }, { campaignId: camp.id, mission: "../../etc" }, { campaignId: 5 }, {}])
      await expect(dispatch("tests:list", args, ctx(board) as never)).rejects.toThrow();
    await expect(dispatch("tests:coverage", { missionId: "" }, ctx(board) as never)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("unknown ids answer with empty results, never a throw", async () => {
    const { board } = testsFixture();
    expect(await dispatch("tests:list", { campaignId: "nope" }, ctx(board) as never)).toEqual([]);
    expect(await dispatch("tests:coverage", { missionId: "nope" }, ctx(board) as never)).toMatchObject({ mission: null, acs: [], uncovered: [] });
  });

  it("writes nothing: runs/ and evidence/ files and the TCs are untouched by every tests:* call", async () => {
    const { board, camp, m1, dir } = testsFixture();
    mkdirSync(join(dir, "m1", "runs"), { recursive: true });
    writeFileSync(join(dir, "m1", "runs", "RUN-1.md"), "run");
    const snap = () => readdirSync(join(dir, "m1"), { recursive: true }).map(String).sort().map((f) => f + statSync(join(dir, "m1", f)).mtimeMs).join("|");
    const before = snap();
    await dispatch("tests:list", { campaignId: camp.id }, ctx(board) as never);
    await dispatch("tests:coverage", { missionId: m1.id }, ctx(board) as never);
    await dispatch("tests:summary", { campaignId: camp.id }, ctx(board) as never);
    expect(snap()).toBe(before);
  });
});


// ── tests:get / tests:setStatus (T1.2) ──────────────────────────────────────────────────────────

describe("tests:get and tests:setStatus routes", () => {
  function fixture() {
    const { board, repoRoot } = makeBoardWithRoot();
    const camp = board.createCampaign({ name: "C" });
    board.createMission({ title: "M1 - Thing", campaignId: camp.id });
    const dir = join(repoRoot, ".octobots", camp.folderPath, "tests", "m1");
    mkdirSync(dir, { recursive: true });
    const text = "---\nid: TC-001\ntitle: t\nmission: M1\ncovers: [M1-AC1]\nkind: unit\nstatus: draft\n---\n\n# TC-001\n";
    writeFileSync(join(dir, "TC-001_x.md"), text);
    board.reconcile();
    return { board, file: join(dir, "TC-001_x.md"), path: `${camp.folderPath}/tests/m1/TC-001_x.md`, text };
  }

  it("routes tests:get to board.getTestCaseDetail", async () => {
    const { board, path } = fixture();
    const spy = vi.spyOn(board, "getTestCaseDetail");
    const d = (await dispatch("tests:get", { path }, ctx(board) as never)) as { tc: { id: string; status: string } };
    expect(spy).toHaveBeenCalledWith(path);
    expect(d.tc).toMatchObject({ id: "TC-001", status: "draft" });
    expect(await dispatch("tests:get", { path: "campaigns/x/tests/m1/TC-404_none.md" }, ctx(board) as never)).toBeNull();
  });

  it("routes tests:setStatus to board.setTestStatus with the path, the status and the base", async () => {
    const { board, path, file } = fixture();
    const spy = vi.spyOn(board, "setTestStatus");
    const base = { status: "draft", lastRun: null };
    expect(await dispatch("tests:setStatus", { path, status: "ready", base }, ctx(board) as never)).toMatchObject({ ok: true, changed: true });
    expect(spy).toHaveBeenCalledWith(path, "ready", base);
    expect(readFileSync(file, "utf8")).toMatch(/^status: ready$/m);
  });

  it("rejects status unknown and a malformed base before any handler runs", async () => {
    const { board, path, file, text } = fixture();
    const spy = vi.spyOn(board, "setTestStatus");
    for (const args of [
      { path, status: "unknown", base: { status: "draft", lastRun: null } },
      { path, status: "pass", base: { status: "bogus", lastRun: null } },
      { path, status: "pass" },
      { status: "pass", base: { status: "draft", lastRun: null } },
    ]) await expect(dispatch("tests:setStatus", args, ctx(board) as never)).rejects.toThrow();
    await expect(dispatch("tests:get", { path: "" }, ctx(board) as never)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});
