import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, setStatus } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-ms-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("mission status from campaign ## Missions board line", () => {
  it("reads [status:X] marker on the mission board line", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] ac" });

    // Hand-write the [status:executing] marker into the campaign.md ## Missions board line
    const campaignMd = join(root, c.folderPath, "campaign.md");
    const text = readFileSync(campaignMd, "utf8");
    // Replace `- M1 - Skills` with `- [status:executing] M1 - Skills`
    const updated = text.replace("- M1 - Skills", "- [status:executing] M1 - Skills");
    writeFileSync(campaignMd, updated, "utf8");

    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getMission(m.id)?.status).toBe("executing");
  });

  it("defaults to 'draft' when no [status:X] marker is present", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "M2 - Auth", acceptanceCriteria: "- [ ] ac" });

    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getMission(m.id)?.status).toBe("draft");
  });

  // Em-dash `<id> — name` titles (the board's convention) must round-trip status. boardLineEntityName
  // truncates "M9 — Foo" to "M9" when keying the status map, so the lookup must do the same — else the
  // marker is written but never read back, and the mission stays draft forever.
  it("round-trips status for an em-dash `<id> — name` mission title", () => {
    const c = createCampaign(root, { name: "Octoweb" });
    const m = createMission(root, c.id, { title: "M9 — Agent filesystem substrate", acceptanceCriteria: "- [ ] ac" });
    expect(setStatus(root, "mission", m.id, "executing")).toBe(true);
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getMission(m.id)?.status).toBe("executing");
  });

  it("round-trips status for an em-dash task title", () => {
    const c = createCampaign(root, { name: "Octoweb" });
    const m = createMission(root, c.id, { title: "M9 — Substrate", acceptanceCriteria: "- [ ] ac" });
    createTask(root, m.id, { name: "T9.1 — Wire the loader", acceptanceCriteria: "- [ ] ac" });
    const t0 = new BoardModel(root); t0.rebuild();
    const taskId = t0.listTasks(m.id)[0]!.id;
    expect(setStatus(root, "task", taskId, "done")).toBe(true);
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getTask(taskId)?.status).toBe("done");
  });
});
