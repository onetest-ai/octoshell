import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, createBug, setStatus } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-st-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function reread(r: string): BoardModel {
  const b = new BoardModel(r);
  b.rebuild();
  return b;
}
function firstTaskId(b: BoardModel, missionId: string): string {
  const t = b.listTasks(missionId)[0];
  if (!t) throw new Error("No tasks found");
  return t.id;
}

// Status lives in each entity's OWN yaml — no parent projection — so every assertion is a
// BoardModel round-trip rather than a check on a parent board line.

it("sets a task's status in its own file; BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "- [ ] a" });
  createTask(root, m.id, { name: "T1.1 - JWT", role: "dev", acceptanceCriteria: "- [ ] a" });
  const tid = firstTaskId(reread(root), m.id);
  expect(setStatus(root, "task", tid, "active")).toBe(true);
  expect(reread(root).getTask(tid)?.status).toBe("executing");
});

it("returns false for an unknown status word", () => {
  const c = createCampaign(root, { name: "Q3" });
  expect(setStatus(root, "campaign", c.id, "bogus")).toBe(false);
});

it("sets a mission status; BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] a" });
  expect(setStatus(root, "mission", m.id, "active")).toBe(true);
  expect(reread(root).getMission(m.id)?.status).toBe("executing");
});

it("sets a bug status; BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1", acceptanceCriteria: "- [ ] a" });
  const b = createBug(root, { missionId: m.id }, { title: "Crash on load" });
  expect(setStatus(root, "bug", b.id, "done")).toBe(true);
  expect(reread(root).getBug(b.id)?.status).toBe("done");
});

it("sets campaign status and BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  expect(setStatus(root, "campaign", c.id, "done")).toBe(true);
  expect(reread(root).getCampaign(c.id)?.status).toBe("done");
});

it("returns false when entity id is not found", () => {
  expect(setStatus(root, "task", "nonexistent-id", "active")).toBe(false);
});

it("status persists across reloads for every kind (folder-derived, no parent line to lose)", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1", acceptanceCriteria: "- [ ] a" });
  createTask(root, m.id, { name: "Orphan Task", acceptanceCriteria: "- [ ] a" });
  const tid = firstTaskId(reread(root), m.id);
  setStatus(root, "mission", m.id, "active");
  setStatus(root, "task", tid, "done");
  const b = reread(root);
  expect(b.getMission(m.id)?.status).toBe("executing");
  expect(b.getTask(tid)?.status).toBe("done");
});
