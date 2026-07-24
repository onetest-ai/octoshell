import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, updateBrief, addCriterion, setCriterion, addDocument, removeDocument, setStatus } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-ed-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function reread(r: string): BoardModel {
  const b = new BoardModel(r);
  b.rebuild();
  return b;
}

it("updates a mission description; BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "- [ ] a" });
  expect(updateBrief(root, "mission", m.id, { description: "new desc" })).toBe(true);
  expect(reread(root).getMission(m.id)?.description).toBe("new desc");
});

it("sets campaign status; BoardModel reads it back", () => {
  const c = createCampaign(root, { name: "Q3" });
  expect(setStatus(root, "campaign", c.id, "done")).toBe(true);
  expect(reread(root).getCampaign(c.id)?.status).toBe("done");
});

it("adds and checks acceptance criteria", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "" });
  addCriterion(root, "mission", m.id, "Ship feature");
  setCriterion(root, "mission", m.id, 1, true);
  expect(reread(root).getMission(m.id)?.acceptanceCriteria).toContain("- [x] Ship feature");
});

it("adds a document link idempotently and removes it", () => {
  const c = createCampaign(root, { name: "Q3" });
  addDocument(root, "campaign", c.id, "Spec", "docs/spec.md");
  addDocument(root, "campaign", c.id, "Spec", "docs/spec.md");
  const yamlPath = join(root, c.folderPath, "campaign.yaml");
  expect(readFileSync(yamlPath, "utf8").match(/docs\/spec\.md/g)?.length).toBe(1);
  removeDocument(root, "campaign", c.id, "docs/spec.md");
  expect(readFileSync(yamlPath, "utf8")).not.toContain("docs/spec.md");
});
