import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createMission, updateBrief, addCriterion, setCriterion, addDocument, removeDocument, setStatus } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "board-ed-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it("updates a mission description while preserving the ## Tasks tail", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "- [ ] a" });
  expect(updateBrief(root, "mission", m.id, { description: "new desc" })).toBe(true);
  const md = readFileSync(join(root, m.folderPath, "mission.md"), "utf8");
  expect(md).toContain("new desc");
  expect(md).toContain("## Tasks");
});

it("sets campaign status via the ## Status section", () => {
  const c = createCampaign(root, { name: "Q3" });
  expect(setStatus(root, "campaign", c.id, "done")).toBe(true);
  const b = new BoardModel(root); b.rebuild();
  expect(b.getCampaign(c.id)?.status).toBe("done");
});

it("adds and checks acceptance criteria", () => {
  const c = createCampaign(root, { name: "Q3" });
  const m = createMission(root, c.id, { title: "M1 - x", acceptanceCriteria: "" });
  addCriterion(root, "mission", m.id, "Ship feature");
  setCriterion(root, "mission", m.id, 1, true);
  const md = readFileSync(join(root, m.folderPath, "mission.md"), "utf8");
  expect(md).toContain("- [x] Ship feature");
});

it("adds a document link idempotently", () => {
  const c = createCampaign(root, { name: "Q3" });
  addDocument(root, "campaign", c.id, "Spec", "docs/spec.md");
  addDocument(root, "campaign", c.id, "Spec", "docs/spec.md");
  const md = readFileSync(join(root, c.folderPath, "campaign.md"), "utf8");
  expect(md.match(/docs\/spec\.md/g)?.length).toBe(1);
  removeDocument(root, "campaign", c.id, "docs/spec.md");
  expect(readFileSync(join(root, c.folderPath, "campaign.md"), "utf8")).not.toContain("docs/spec.md");
});
