/**
 * `notes` must be editable through the same brief-update path every other field uses, so the app's
 * Notes panel can save. Notes are the entity's decision record — the write has to round-trip the
 * text verbatim, including the markdown structure a reader depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, createTask, createBug, updateBrief } from "../src/write.js";
import { loadEntity } from "../src/entity-schema.js";

let boardRoot: string;

beforeEach(() => {
  boardRoot = join(mkdtempSync(join(tmpdir(), "write-notes-")), ".octobots");
  mkdirSync(boardRoot, { recursive: true });
});
afterEach(() => {
  rmSync(join(boardRoot, ".."), { recursive: true, force: true });
});

const MARKDOWN = [
  "## Amendment (Alex) — SQUAD_TOO_SMALL",
  "",
  "Two reason codes added to the closed set after T1.1's review; see the mission's `notes`",
  "for the full decision record.",
  "",
  "- floor tested at 6-vs-7 players per side",
  "- duplicate check counted across both teams",
].join("\n");

const read = (folderPath: string, kind: string): ReturnType<typeof loadEntity> =>
  loadEntity(readFileSync(join(boardRoot, folderPath, `${kind}.yaml`), "utf8"));

describe("updateBrief writes notes", () => {
  it("sets notes on a task without disturbing its other fields", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", description: "d", acceptanceCriteria: "- [ ] jwt" });

    expect(updateBrief(boardRoot, "task", t.id, { notes: MARKDOWN })).toBe(true);

    const after = read(t.folderPath, "task");
    expect(after.notes).toBe(MARKDOWN);
    expect(after.description).toBe("d");
    expect(after.acceptanceCriteria).toEqual([{ text: "jwt", done: false }]);
  });

  it("sets notes on a campaign, mission and bug", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const b = createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Broken" });

    updateBrief(boardRoot, "campaign", c.id, { notes: "campaign note" });
    updateBrief(boardRoot, "mission", m.id, { notes: "mission note" });
    updateBrief(boardRoot, "bug", b.id, { notes: "bug note" });

    expect(read(c.folderPath, "campaign").notes).toBe("campaign note");
    expect(read(m.folderPath, "mission").notes).toBe("mission note");
    expect(read(b.folderPath, "bug").notes).toBe("bug note");
  });

  it("clears notes when set to an empty string", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    updateBrief(boardRoot, "campaign", c.id, { notes: "temporary" });
    expect(read(c.folderPath, "campaign").notes).toBe("temporary");

    updateBrief(boardRoot, "campaign", c.id, { notes: "" });
    expect(read(c.folderPath, "campaign").notes).toBeUndefined();
  });

  it("leaves existing notes untouched when the patch omits them", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    updateBrief(boardRoot, "campaign", c.id, { notes: MARKDOWN });

    updateBrief(boardRoot, "campaign", c.id, { description: "changed" });

    const after = read(c.folderPath, "campaign");
    expect(after.notes).toBe(MARKDOWN);
    expect(after.description).toBe("changed");
  });
});
