import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, createBug, setStatus } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-st-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function findTaskId(root: string, missionId: string): string {
  const b = new BoardModel(root);
  b.rebuild();
  const tasks = b.listTasks(missionId);
  const first = tasks[0];
  if (!first) throw new Error("No tasks found");
  return first.id;
}

it("sets a task status marker on the mission board line, preserving other markers", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "- [ ] a" });
  createTask(root, m.id, { name: "T1.1 - JWT", role: "dev", acceptanceCriteria: "- [ ] a" });
  const taskId = findTaskId(root, m.id);
  expect(setStatus(root, "task", taskId, "active")).toBe(true);
  const md = readFileSync(join(root, m.folderPath, "mission.md"), "utf8");
  expect(md).toMatch(/- \[role:dev\] \[status:executing\] T1\.1 - JWT/);
});

it("returns false for an unknown status word", () => {
  const c = createCampaign(root, { name: "Q3" });
  expect(setStatus(root, "campaign", c.id, "bogus")).toBe(false);
});

it("sets a mission status marker on the campaign board line", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] a" });
  expect(setStatus(root, "mission", m.id, "active")).toBe(true);
  const md = readFileSync(join(root, c.folderPath, "campaign.md"), "utf8");
  expect(md).toMatch(/- \[status:executing\] M1 - Skills/);
});

it("sets a bug status marker on the parent mission board line", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1", acceptanceCriteria: "- [ ] a" });
  const b = createBug(root, { missionId: m.id }, { title: "Crash on load" });
  expect(setStatus(root, "bug", b.id, "done")).toBe(true);
  const md = readFileSync(join(root, m.folderPath, "mission.md"), "utf8");
  expect(md).toMatch(/- \[status:done\] Crash on load/);
});

it("sets campaign status via updateBrief and BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  expect(setStatus(root, "campaign", c.id, "done")).toBe(true);
  const b = new BoardModel(root);
  b.rebuild();
  expect(b.getCampaign(c.id)?.status).toBe("done");
});

it("returns false when entity id is not found", () => {
  expect(setStatus(root, "task", "nonexistent-id", "active")).toBe(false);
});

// Folder-path identity: an entity can exist as a folder with NO board line in its parent.
// Status lives only as a `[status:]` marker on that board line, so setStatus must CREATE the
// line when missing — otherwise the status can never leave draft (it silently reverts in the UI).
it("creates the mission board line when missing, so status persists", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "Orphan Mission", acceptanceCriteria: "- [ ] a" });
  const campaignMd = join(root, c.folderPath, "campaign.md");
  // Strip the auto-added `## Missions` line → mission becomes a folder with no board line.
  writeFileSync(campaignMd, readFileSync(campaignMd, "utf8").replace(/^- .*Orphan Mission.*$/m, ""), "utf8");
  expect(setStatus(root, "mission", m.id, "active")).toBe(true);
  const b = new BoardModel(root); b.rebuild();
  expect(b.getMission(m.id)?.status).toBe("executing");
});

it("creates the task board line when missing, so status persists", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1", acceptanceCriteria: "- [ ] a" });
  createTask(root, m.id, { name: "Orphan Task", acceptanceCriteria: "- [ ] a" });
  const taskId = findTaskId(root, m.id);
  const missionMd = join(root, m.folderPath, "mission.md");
  writeFileSync(missionMd, readFileSync(missionMd, "utf8").replace(/^- .*Orphan Task.*$/m, ""), "utf8");
  expect(setStatus(root, "task", taskId, "active")).toBe(true);
  const b = new BoardModel(root); b.rebuild();
  expect(b.getTask(taskId)?.status).toBe("executing");
});
