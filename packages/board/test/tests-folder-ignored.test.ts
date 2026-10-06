/**
 * A campaign's `tests/` folder (functional test cases: README, TC-NNN_*.md, runs/, evidence/) holds no
 * board entity. BoardModel must create nothing from it, so a TC file can never become a mission, task,
 * bug or campaign, whatever it is named or contains. Checked on real board copies (campaign notes, Test
 * conventions rule 2) and with entity-shaped files planted inside tests/.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardModel } from "../src/board-model.js";
import { campaignDirs, realBoardCopies } from "./fixtures/real-board.js";
import { readmeText, scratch, synthBoard, tcText, writeTests } from "./fixtures/tests-board.js";

/** One line per campaign, mission, task and bug: `<kind>\t<id>`, sorted (what qa/dump-ids.mjs prints). */
function entityIds(board: string): string[] {
  const model = new BoardModel(board);
  model.rebuild();
  const lines: string[] = [];
  for (const c of model.listCampaigns()) {
    lines.push(`campaign\t${c.id}`);
    for (const b of model.listBugs({ campaignId: c.id })) lines.push(`bug\t${b.id}`);
    for (const m of model.listMissions(c.id)) {
      lines.push(`mission\t${m.id}`);
      for (const t of model.listTasks(m.id)) lines.push(`task\t${t.id}`);
      for (const b of model.listBugs({ missionId: m.id })) lines.push(`bug\t${b.id}`);
    }
  }
  return lines.sort();
}

const YAML = (name: string): string => `name: ${name}\nstatus: executing\nacceptance_criteria:\n  - text: a\n    done: false\n`;

describe("BoardModel and a campaign's tests/ folder", () => {
  it("over every real board copy: entity ids are identical with and without tests/", () => {
    for (const board of realBoardCopies()) {
      const withTests = entityIds(board);
      expect(withTests.length).toBeGreaterThan(0);
      for (const c of campaignDirs(board)) rmSync(join(c, "tests"), { recursive: true, force: true });
      expect(campaignDirs(board).some((c) => existsSync(join(c, "tests")))).toBe(false);
      expect(entityIds(board)).toEqual(withTests);
    }
  });

  it("over every real board copy: entity-shaped files planted inside tests/ create no entity", () => {
    for (const board of realBoardCopies()) {
      const before = entityIds(board);
      for (const campaignDir of campaignDirs(board)) {
        const t = join(campaignDir, "tests");
        for (const dir of ["m1", join("m1", "missions", "m9"), join("m1", "tasks", "t1"), join("m1", "bugs", "b1"), join("missions", "m9"), join("bugs", "b1"), join("m1", "runs"), join("m1", "evidence")]) {
          mkdirSync(join(t, dir), { recursive: true });
        }
        writeFileSync(join(t, "campaign.yaml"), YAML("Planted campaign"));
        writeFileSync(join(t, "m1", "mission.yaml"), YAML("M1 - Planted mission"));
        writeFileSync(join(t, "m1", "missions", "m9", "mission.yaml"), YAML("M9 - Planted nested mission"));
        writeFileSync(join(t, "m1", "tasks", "t1", "task.yaml"), YAML("T1 - Planted task"));
        writeFileSync(join(t, "m1", "bugs", "b1", "bug.yaml"), "name: Planted bug\nseverity: low\n");
        writeFileSync(join(t, "missions", "m9", "mission.yaml"), YAML("M9 - Planted mission"));
        writeFileSync(join(t, "bugs", "b1", "bug.yaml"), "name: Planted campaign bug\nseverity: low\n");
        writeFileSync(join(t, "m1", "mission.md"), "# M1 - Planted legacy mission\n");
        writeFileSync(join(t, "m1", "README.md"), readmeText([["M1-AC1", "TC-001"]]));
        writeFileSync(join(t, "m1", "TC-001_planted.md"), tcText(["id: TC-001", "covers: [M1-AC1]"]));
        writeFileSync(join(t, "m1", "runs", "RUN-2026-10-06-001.md"), "# run\n");
        writeFileSync(join(t, "m1", "evidence", "shot.png"), "png");
      }
      expect(entityIds(board)).toEqual(before);
    }
  });

  it("a directory holding only tests/ is no campaign, and a campaign's TC files are no entities", () => {
    const c = synthBoard(scratch("tests-ignored-"), [{ title: "M1 - Auth", acs: 1 }]);
    const before = entityIds(c.board);
    expect(before.filter((l) => l.startsWith("mission\t"))).toHaveLength(1);
    writeTests(c, "m1", { "README.md": readmeText([["M1-AC1", "TC-001"]]), "TC-001_a.md": tcText(["id: TC-001", "covers: [M1-AC1]"]) });
    const stray = join(c.board, "campaigns", "only-tests");
    mkdirSync(join(stray, "tests", "m1"), { recursive: true });
    writeFileSync(join(stray, "tests", "m1", "TC-001_a.md"), tcText(["id: TC-001", "covers: [M1-AC1]"]));
    expect(entityIds(c.board)).toEqual(before);
    expect(readdirSync(join(c.board, "campaigns")).sort()).toContain("only-tests");
  });
});
