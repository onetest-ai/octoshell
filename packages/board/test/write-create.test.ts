import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, createBug } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";
import { validateBoard } from "../src/validate.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-w-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function reread(r: string): BoardModel {
  const b = new BoardModel(r);
  b.rebuild();
  return b;
}

describe("createCampaign", () => {
  it("scaffolds campaign.yaml (no .md); folder-path id; BoardModel reads it", () => {
    const { id, folderPath } = createCampaign(root, { name: "Q3 Rollout" });
    expect(folderPath).toBe("campaigns/q3-rollout");
    expect(id).toBe("folder:campaigns/q3-rollout");
    expect(existsSync(join(root, folderPath, "campaign.yaml"))).toBe(true);
    expect(existsSync(join(root, folderPath, "campaign.md"))).toBe(false);
    const b = reread(root);
    expect(b.getCampaign(id)?.name).toBe("Q3 Rollout");
    expect(b.getCampaign(id)?.status).toBe("draft");
  });
});

describe("createMission/Task/Bug", () => {
  it("scaffolds folder-derived children with their fields; the parent has no projection", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] ac" });
    expect(existsSync(join(root, m.folderPath, "mission.yaml"))).toBe(true);
    const t = createTask(root, m.id, { name: "T1.1 - JWT", role: "dev", acceptanceCriteria: "- [ ] ac" });
    const bug = createBug(root, { missionId: m.id }, { title: "Crash on load", severity: "critical" });

    const b = reread(root);
    expect(b.getMission(m.id)?.title).toBe("M1 - Skills");
    expect(b.getTask(t.id)?.name).toBe("T1.1 - JWT");
    expect(b.getBug(bug.id)?.title).toBe("Crash on load");
    expect(b.getBug(bug.id)?.severity).toBe("critical");
    // Children are folder-derived — the campaign yaml never enumerates its missions.
    expect(readFileSync(join(root, c.folderPath, "campaign.yaml"), "utf8")).not.toContain("missions");
  });
});

describe("the add-task-under-bugs misplacement bug is structurally impossible", () => {
  it("adding a task to a mission that already has a bug yields a task, not a bug", () => {
    const c = createCampaign(root, { name: "C" });
    const m = createMission(root, c.id, { title: "M1", acceptanceCriteria: "- [ ] a" });
    createBug(root, { missionId: m.id }, { title: "A crash bug" });
    const t = createTask(root, m.id, { name: "T1.1 - Real task", acceptanceCriteria: "- [ ] a" });

    const b = reread(root);
    expect(b.listTasks(m.id).map((x) => x.name)).toEqual(["T1.1 - Real task"]);
    expect(b.listBugs({ missionId: m.id }).map((x) => x.title)).toEqual(["A crash bug"]);
    expect(b.getTask(t.id)).toBeDefined();
  });
});

describe("validate is clean for a well-formed YAML board", () => {
  it("a mission-less campaign and a criterion'd task both validate", () => {
    const c = createCampaign(root, { name: "Q3 Rollout" });
    expect(validateBoard(root)).toEqual([]);
    const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] ac" });
    createTask(root, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] ac" });
    expect(validateBoard(root)).toEqual([]);
  });
});

describe("createBug on campaign", () => {
  it("BoardModel lists a campaign-level bug", () => {
    const c = createCampaign(root, { name: "Camp Bugs" });
    const bug = createBug(root, { campaignId: c.id }, { title: "Camp bug" });
    const b = reread(root);
    expect(b.listBugs({ campaignId: c.id }).map((x) => x.id)).toContain(bug.id);
    expect(b.getBug(bug.id)?.title).toBe("Camp bug");
  });
});
