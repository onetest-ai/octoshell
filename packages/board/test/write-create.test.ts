import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, createBug } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";
import { parseManagedBlock } from "../src/managed-block.js";
import { validateBoard } from "../src/validate.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-w-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("createCampaign", () => {
  it("scaffolds campaign.md with no octobots:id marker; id is folder-path based", () => {
    const { id, folderPath } = createCampaign(root, { name: "Q3 Rollout" });
    const md = readFileSync(join(root, folderPath, "campaign.md"), "utf8");
    expect(folderPath).toBe("campaigns/q3-rollout");
    // Returned id is the folder-path identity — no marker written into the file.
    expect(id).toBe("folder:campaigns/q3-rollout");
    expect(md).not.toContain("octobots:id");
    const f = parseManagedBlock(md);
    expect(f.id).toBeUndefined(); // no marker in file
    expect(f.name).toBe("Q3 Rollout");
    expect(f.status).toBe("draft");
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getCampaign(id)?.name).toBe("Q3 Rollout");
  });
});

describe("createMission/Task/Bug", () => {
  it("scaffolds the folder and appends a board line to the parent", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] ac" });
    expect(existsSync(join(root, m.folderPath, "mission.md"))).toBe(true);
    expect(readFileSync(join(root, c.folderPath, "campaign.md"), "utf8")).toContain("- M1 - Skills");

    const t = createTask(root, m.id, { name: "T1.1 - JWT", role: "dev", acceptanceCriteria: "- [ ] ac" });
    expect(readFileSync(join(root, m.folderPath, "mission.md"), "utf8")).toContain("- [role:dev] T1.1 - JWT");

    const b = createBug(root, { missionId: m.id }, { title: "Crash on load", severity: "critical" });
    expect(readFileSync(join(root, m.folderPath, "mission.md"), "utf8")).toContain("- [severity:critical] Crash on load");

    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getMission(m.id)?.title).toBe("M1 - Skills");
    expect(board.getTask(t.id)?.name).toBe("T1.1 - JWT");
    expect(board.getBug(b.id)?.title).toBe("Crash on load");
  });
});

describe("addBoardLine multi-section insertion (I1)", () => {
  it("inserts a new mission line within ## Missions, before ## Bugs, when both sections exist", () => {
    const c = createCampaign(root, { name: "Multi-Section" });
    // Create first mission so ## Missions already has one line
    const m1 = createMission(root, c.id, { title: "M1 Alpha" });

    // Manually append a ## Bugs section to campaign.md (simulating an agent-written tail)
    const campaignMd = join(root, c.folderPath, "campaign.md");
    const existing = readFileSync(campaignMd, "utf8");
    writeFileSync(campaignMd, existing + "\n## Bugs\n- some bug\n", "utf8");

    // Create second mission — addBoardLine must insert under ## Missions, not after ## Bugs
    const m2 = createMission(root, c.id, { title: "M2 Beta" });

    const content = readFileSync(campaignMd, "utf8");
    const missionsIdx = content.indexOf("## Missions");
    const bugsIdx = content.indexOf("## Bugs");
    const m2Idx = content.indexOf("- M2 Beta");

    // M2 must appear after ## Missions and before ## Bugs
    expect(m2Idx).toBeGreaterThan(missionsIdx);
    expect(m2Idx).toBeLessThan(bugsIdx);

    // ## Bugs section with its original line must still be intact
    expect(content).toContain("## Bugs\n- some bug");

    // BoardModel must list both missions under the campaign
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getMission(m1.id)?.title).toBe("M1 Alpha");
    expect(board.getMission(m2.id)?.title).toBe("M2 Beta");
    const missions = board.listMissions(c.id);
    expect(missions.map((m) => m.id)).toContain(m1.id);
    expect(missions.map((m) => m.id)).toContain(m2.id);
  });
});

describe("created entities carry an agent-owned section (validate parity with the scripts)", () => {
  it("createCampaign scaffolds a `## Missions` section, so a mission-less campaign is well-formed", () => {
    const c = createCampaign(root, { name: "Q3 Rollout" });
    const md = readFileSync(join(root, c.folderPath, "campaign.md"), "utf8");
    expect(md).toContain("## Missions");
    expect(validateBoard(root)).toEqual([]);
  });

  it("createTask scaffolds a `## Tasks` section, so a fresh task with a criterion is well-formed", () => {
    const c = createCampaign(root, { name: "Q3" });
    const m = createMission(root, c.id, { title: "M1 - Skills", acceptanceCriteria: "- [ ] ac" });
    const t = createTask(root, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] ac" });
    const taskMd = readFileSync(join(root, t.folderPath, "task.md"), "utf8");
    expect(taskMd).toContain("## Tasks");
    // The whole tree (campaign + mission + criterion'd task) is well-formed — no missing-section findings.
    expect(validateBoard(root)).toEqual([]);
  });
});

describe("createBug on campaign (M3)", () => {
  it("writes the bug line into campaign.md ## Bugs and BoardModel sees it", () => {
    const c = createCampaign(root, { name: "Camp Bugs" });
    const b = createBug(root, { campaignId: c.id }, { title: "Camp bug" });

    const campaignMd = join(root, c.folderPath, "campaign.md");
    const content = readFileSync(campaignMd, "utf8");
    expect(content).toContain("## Bugs");
    expect(content).toContain("- Camp bug");

    const board = new BoardModel(root);
    board.rebuild();
    const bugs = board.listBugs({ campaignId: c.id });
    expect(bugs.map((bug) => bug.id)).toContain(b.id);
    expect(board.getBug(b.id)?.title).toBe("Camp bug");
  });
});
