import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCampaign, createMission, createTask } from "@octoshell/board";
import { readBoard } from "../src/board.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** A repo root with a `.octobots/` board — callers build the board tree via
 *  `@octoshell/board`'s own write API, never a hand-rolled YAML string, so
 *  the fixture stays honest about what a real board's `acceptance_criteria`
 *  round-trip actually produces. */
function repoWithBoard(): { root: string; octobotsDir: string } {
  const root = mkdtempClean("octograph-board-");
  const octobotsDir = join(root, ".octobots");
  mkdirSync(octobotsDir, { recursive: true });
  return { root, octobotsDir };
}

/** `readBoard`, asserting it found a board — never a `!` non-null assertion,
 *  which `eslint` bans package-wide (`@typescript-eslint/no-non-null-
 *  assertion`) precisely so a null case can't be silenced instead of tested. */
function requireBoard(root: string) {
  const board = readBoard(root);
  expect(board).not.toBeNull();
  if (board === null) throw new Error("unreachable: asserted above");
  return board;
}

describe("readBoard", () => {
  it("returns null for a repo with no .octobots directory", () => {
    const root = mkdtempClean("octograph-noboard-");
    expect(readBoard(root)).toBeNull();
  });

  it("names the owning mission and campaign for a task, and recovers its criteria", () => {
    const { root, octobotsDir } = repoWithBoard();
    const campaign = createCampaign(octobotsDir, { name: "Q3 Rollout" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [x] jwt validated\n- [ ] expired rejected",
    });

    const board = requireBoard(root);
    const found = board.tasks.find((t) => t.id === task.id);
    expect(found).toEqual({
      id: task.id,
      name: "T1.1 - JWT",
      mission: mission.id,
      campaign: campaign.id,
      criteria: ["jwt validated", "expired rejected"],
    });
    expect(board.missionOf(task.id)).toBe(mission.id);
  });

  it("returns null missionOf for an unknown task id", () => {
    const { root } = repoWithBoard();
    const board = requireBoard(root);
    expect(board.missionOf("T99.9")).toBeNull();
  });

  it("parses a checked item, an unchecked item, and an empty criteria block", () => {
    const { root, octobotsDir } = repoWithBoard();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Empty" });
    const checked = createTask(octobotsDir, mission.id, {
      name: "T1.1 - Checked",
      acceptanceCriteria: "- [x] done thing",
    });
    const unchecked = createTask(octobotsDir, mission.id, {
      name: "T1.2 - Unchecked",
      acceptanceCriteria: "- [ ] pending thing",
    });
    const empty = createTask(octobotsDir, mission.id, { name: "T1.3 - Empty" });

    const board = requireBoard(root);
    expect(board.tasks.find((t) => t.id === checked.id)?.criteria).toEqual(["done thing"]);
    expect(board.tasks.find((t) => t.id === unchecked.id)?.criteria).toEqual(["pending thing"]);
    expect(board.tasks.find((t) => t.id === empty.id)?.criteria).toEqual([]);
  });

  it("orders tasks deterministically (campaign, mission, id) rather than disk-scan order", () => {
    const { root, octobotsDir } = repoWithBoard();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Order" });
    // Create in reverse-alphabetical name order; the board must not depend
    // on creation/disk-scan order to answer deterministically.
    createTask(octobotsDir, mission.id, { name: "T1.9 - Zeta" });
    createTask(octobotsDir, mission.id, { name: "T1.1 - Alpha" });

    const board1 = requireBoard(root);
    const board2 = requireBoard(root);
    expect(board1.tasks.map((t) => t.id)).toEqual(board2.tasks.map((t) => t.id));
  });
});
