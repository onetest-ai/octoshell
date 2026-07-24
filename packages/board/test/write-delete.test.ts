import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, createBug, deleteTask, deleteBug, deleteMission, deleteCampaign, trashFolder } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-del-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it("trashes a task's folder; BoardModel no longer lists it", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "- [ ] a" });
  const t = createTask(root, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] a" });
  expect(deleteTask(root, t.id)).toBe(true);
  expect(existsSync(join(root, t.folderPath))).toBe(false);
  expect(existsSync(join(root, ".trash"))).toBe(true);
  const b = new BoardModel(root); b.rebuild();
  expect(b.getTask(t.id)).toBeNull();
});

it("returns false for unknown task id", () => {
  expect(deleteTask(root, "no-such-id")).toBe(false);
});

it("does not create .trash when task id is not found", () => {
  deleteTask(root, "no-such-id");
  expect(existsSync(join(root, ".trash"))).toBe(false);
});

describe("deleteBug", () => {
  it("trashes a mission-level bug's folder; BoardModel no longer lists it", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "Sprint 1", acceptanceCriteria: "- [ ] a" });
    const bug = createBug(root, { missionId: m.id }, { title: "Login Crash", severity: "critical" });
    expect(deleteBug(root, bug.id)).toBe(true);
    expect(existsSync(join(root, bug.folderPath))).toBe(false);
    expect(existsSync(join(root, ".trash"))).toBe(true);
    const board = new BoardModel(root); board.rebuild();
    expect(board.getBug(bug.id)).toBeNull();
  });

  it("trashes a campaign-level bug's folder; BoardModel no longer lists it", () => {
    const c = createCampaign(root, { name: "Q3" });
    const bug = createBug(root, { campaignId: c.id }, { title: "Signup Error", severity: "major" });
    expect(deleteBug(root, bug.id)).toBe(true);
    expect(existsSync(join(root, bug.folderPath))).toBe(false);
    expect(existsSync(join(root, ".trash"))).toBe(true);
    const board = new BoardModel(root); board.rebuild();
    expect(board.getBug(bug.id)).toBeNull();
  });

  it("returns false for unknown bug id", () => {
    expect(deleteBug(root, "no-such-id")).toBe(false);
  });
});

describe("deleteMission", () => {
  it("trashes the mission folder; BoardModel no longer lists it", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "Auth Sprint", acceptanceCriteria: "- [ ] a" });
    expect(deleteMission(root, m.id)).toBe(true);
    expect(existsSync(join(root, m.folderPath))).toBe(false);
    expect(existsSync(join(root, ".trash"))).toBe(true);
    const board = new BoardModel(root); board.rebuild();
    expect(board.getMission(m.id)).toBeNull();
  });

  it("returns false for unknown mission id", () => {
    expect(deleteMission(root, "no-such-id")).toBe(false);
  });
});

describe("trashFolder", () => {
  it("returns true when the folder is successfully renamed into .trash", () => {
    const dir = join(root, "campaigns", "test-campaign");
    mkdirSync(dir, { recursive: true });
    const result = trashFolder(dir, root);
    expect(result).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, ".trash", "test-campaign"))).toBe(true);
  });

  it("returns false when the folder does not exist", () => {
    const nonExistent = join(root, "campaigns", "ghost-folder");
    const result = trashFolder(nonExistent, root);
    expect(result).toBe(false);
  });

  it("never throws to the caller even if the folder does not exist", () => {
    const nonExistent = join(root, "campaigns", "missing");
    expect(() => trashFolder(nonExistent, root)).not.toThrow();
  });

  it("handles collision by adding a numeric suffix", () => {
    const dir1 = join(root, "campaigns", "slug");
    const dir2 = join(root, "campaigns", "slug-copy");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    // Trash dir1 first
    trashFolder(dir1, root);
    // Create another folder with same slug name and trash it
    mkdirSync(dir1, { recursive: true });
    trashFolder(dir1, root);
    expect(existsSync(join(root, ".trash", "slug"))).toBe(true);
    expect(existsSync(join(root, ".trash", "slug-2"))).toBe(true);
  });
});

describe("delete functions return folder-trash outcome", () => {
  it("deleteTask returns true (folder trashed) when task exists and folder is present", () => {
    const c = createCampaign(root, { name: "Camp" });
    const m = createMission(root, c.id, { title: "Mission A" });
    const t = createTask(root, m.id, { name: "Task X" });
    // folder-trash is authoritative: if folder was moved, returns true
    const result = deleteTask(root, t.id);
    expect(result).toBe(true);
  });

  it("deleteBug returns true (folder trashed) when bug exists and folder is present", () => {
    const c = createCampaign(root, { name: "Camp" });
    const m = createMission(root, c.id, { title: "Mission B" });
    const bug = createBug(root, { missionId: m.id }, { title: "Crash Bug" });
    const result = deleteBug(root, bug.id);
    expect(result).toBe(true);
  });

  it("deleteMission returns true (folder trashed) when mission exists and folder is present", () => {
    const c = createCampaign(root, { name: "Camp" });
    const m = createMission(root, c.id, { title: "Mission C" });
    const result = deleteMission(root, m.id);
    expect(result).toBe(true);
  });

  it("deleteCampaign returns true (folder trashed) when campaign exists and folder is present", () => {
    const c = createCampaign(root, { name: "Camp" });
    const result = deleteCampaign(root, c.id);
    expect(result).toBe(true);
  });

  it("does not create .trash when bug id is not found", () => {
    deleteBug(root, "no-such-bug");
    expect(existsSync(join(root, ".trash"))).toBe(false);
  });

  it("does not create .trash when mission id is not found", () => {
    deleteMission(root, "no-such-mission");
    expect(existsSync(join(root, ".trash"))).toBe(false);
  });

  it("does not create .trash when campaign id is not found", () => {
    deleteCampaign(root, "no-such-campaign");
    expect(existsSync(join(root, ".trash"))).toBe(false);
  });
});

describe("deleteCampaign", () => {
  it("trashes the campaign folder (no parent board line)", () => {
    const c = createCampaign(root, { name: "Q3" });
    expect(deleteCampaign(root, c.id)).toBe(true);
    expect(existsSync(join(root, c.folderPath))).toBe(false);
    expect(existsSync(join(root, ".trash"))).toBe(true);
    const board = new BoardModel(root); board.rebuild();
    expect(board.getCampaign(c.id)).toBeNull();
  });

  it("returns false for unknown campaign id", () => {
    expect(deleteCampaign(root, "no-such-id")).toBe(false);
  });
});
