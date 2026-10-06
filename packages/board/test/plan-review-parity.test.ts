/**
 * Parity of the two plan-review implementations (mission M5 AC2): the pack's dependency-free
 * `plan-review.mjs` (used by set-status.js) and its TypeScript mirror `planReviewStatus` in this
 * package (used by BoardHost.setStatus). Both must return identical results on the shared case
 * table and on every (mission notes, campaign notes) pair of the real boards. The real boards are
 * what a CI checkout has (`git archive HEAD .octobots`) plus every board in OCTOBOTS_BOARD_COPIES.
 * Results are compared as values; no count is hard-coded.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEntity, planReviewStatus } from "../src/index.js";
import { campaignDirs, trackedBoardCopies } from "./fixtures/real-board.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);
const pack = (await import(pathToFileURL(join(SCRIPTS, "plan-review.mjs")).href)) as {
  planReviewStatus: (missionNotes?: string | null, campaignNotes?: string | null) => unknown;
};

interface Case { id: string; missionNotes: string; campaignNotes: string }
const TABLE = JSON.parse(readFileSync(resolve(__dirname, "fixtures/plan-review-cases.json"), "utf8")) as { cases: Case[] };

/** The notes of `<dir>/<kind>.yaml`, or "" when it is absent or unreadable (the script's rule). */
function notesOf(dir: string, kind: "campaign" | "mission"): string {
  const file = join(dir, `${kind}.yaml`);
  if (!existsSync(file)) return "";
  try {
    return loadEntity(readFileSync(file, "utf8")).notes ?? "";
  } catch {
    return "";
  }
}

/** Every (mission notes, campaign notes) pair of one board directory. */
function pairsOf(board: string): Array<{ label: string; missionNotes: string; campaignNotes: string }> {
  const out: Array<{ label: string; missionNotes: string; campaignNotes: string }> = [];
  for (const campaignDir of campaignDirs(board)) {
    const campaignNotes = notesOf(campaignDir, "campaign");
    const missions = join(campaignDir, "missions");
    if (!existsSync(missions)) continue;
    for (const m of readdirSync(missions, { withFileTypes: true })) {
      if (!m.isDirectory()) continue;
      out.push({ label: `${campaignDir}/${m.name}`, missionNotes: notesOf(join(missions, m.name), "mission"), campaignNotes });
    }
  }
  return out;
}

describe("plan-review parity: pack plan-review.mjs vs packages/board planReviewStatus", () => {
  it("returns identical results on every row of the shared case table", () => {
    expect(TABLE.cases.length).toBeGreaterThan(0);
    for (const c of TABLE.cases) {
      expect(planReviewStatus(c.missionNotes, c.campaignNotes), c.id).toEqual(pack.planReviewStatus(c.missionNotes, c.campaignNotes));
    }
  });

  it("returns identical results on every (mission notes, campaign notes) pair of the real boards", () => {
    const pairs = trackedBoardCopies().flatMap(pairsOf);
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) {
      expect(planReviewStatus(p.missionNotes, p.campaignNotes), p.label).toEqual(pack.planReviewStatus(p.missionNotes, p.campaignNotes));
    }
  });
});
