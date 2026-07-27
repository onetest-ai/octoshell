/**
 * The app-side mirror of the pack validator's "stranded criteria" rule: acceptance criteria that
 * were appended as prose into an entity's free-form `notes` instead of written to
 * `acceptance_criteria`. They read fine to a human but the board model never sees them as criteria,
 * so a task can look complete on disk while validating as criterion-less.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBoard } from "../src/validate.js";
import { dumpEntity, type EntityFields, type EntityKind } from "../src/entity-schema.js";
import { createCampaign, createMission, createTask, createBug } from "../src/write.js";

// validateBoard takes the PROJECT root and walks `<root>/.octobots`; the write helpers take the
// board root itself.
let projectDir: string;
let boardRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "validate-stranded-"));
  boardRoot = join(projectDir, ".octobots");
  mkdirSync(boardRoot, { recursive: true });
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Overwrite an entity's yaml through the parser, with `notes` set. */
function withNotes(folderPath: string, kind: EntityKind, fields: Partial<EntityFields>): void {
  const full: EntityFields = {
    name: "M1 - Auth",
    description: "",
    acceptanceCriteria: [],
    documents: [],
    ...fields,
  };
  writeFileSync(join(boardRoot, folderPath, `${kind}.yaml`), dumpEntity(kind, full), "utf8");
}

const strandedFindings = (): string[] =>
  validateBoard(projectDir)
    .filter((f) => /stranded/i.test(f.message))
    .map((f) => f.message);

describe("validateBoard flags criteria stranded in notes", () => {
  it("reports a task whose criteria live in notes as checkbox prose", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    withNotes(t.folderPath, "task", {
      name: "T1.1 - JWT",
      notes: ["## Acceptance Criteria", "- [ ] expired tokens are rejected", "- [x] tampered tokens are rejected"].join("\n"),
    });

    const messages = strandedFindings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("2");
    expect(messages[0]).toContain("set-criterion.js");
  });

  it("reports the stranded criteria even when real criteria exist", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    withNotes(t.folderPath, "task", {
      name: "T1.1 - JWT",
      acceptanceCriteria: [{ text: "jwt validated", done: false }],
      notes: "- [ ] expired tokens are rejected",
    });

    expect(strandedFindings()).toHaveLength(1);
  });

  it("does not report prose notes without checkbox lines", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] jwt validated" });
    withNotes(t.folderPath, "task", {
      name: "T1.1 - JWT",
      acceptanceCriteria: [{ text: "jwt validated", done: false }],
      notes: "## Decision\nWe rejected sqlite: it breaks multi-agent writes.",
    });

    expect(strandedFindings()).toEqual([]);
  });

  it("does not report a bug's repro checklist", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const b = createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Notes wiped" });
    withNotes(b.folderPath, "bug", { name: "B1 - Notes wiped", notes: "- [x] reproduced on main" });

    expect(strandedFindings()).toEqual([]);
  });

  it("reports a campaign and a mission with stranded criteria", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    withNotes(c.folderPath, "campaign", { name: "Q3 Rollout", notes: "- [ ] every mission merged" });
    withNotes(m.folderPath, "mission", {
      name: "M1 - Auth",
      acceptanceCriteria: [{ text: "ships", done: false }],
      notes: "- [x] auth reviewed",
    });

    expect(strandedFindings()).toHaveLength(2);
  });
});

describe("validateBoard flags a known field on the wrong kind", () => {
  const misplacedFindings = (): string[] =>
    validateBoard(projectDir)
      .filter((f) => /not a .* field/i.test(f.message))
      .map((f) => f.message);

  /** Write a raw yaml body — this is the hand-edit/import case the rule exists for. */
  function rawYaml(folderPath: string, kind: EntityKind, body: string): void {
    writeFileSync(join(boardRoot, folderPath, `${kind}.yaml`), body, "utf8");
  }

  it("reports documents on a task, and says where they belong", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    rawYaml(
      t.folderPath,
      "task",
      "name: T1.1 - JWT\nstatus: draft\ndescription: d\nacceptance_criteria:\n  - text: jwt\n    done: false\ndocuments:\n  - label: Spec\n    target: docs/spec.md\n",
    );

    const messages = misplacedFindings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("documents");
    expect(messages[0]).toContain("campaign/mission");
  });

  it("reports tokenomics on a campaign, role on a mission and acceptance_criteria on a bug", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const b = createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Broken" });
    rawYaml(
      c.folderPath,
      "campaign",
      "name: Q3 Rollout\nstatus: draft\ntarget: ''\ndescription: d\nacceptance_criteria: []\ndocuments: []\ntokenomics:\n  effort_days: 5\n",
    );
    rawYaml(
      m.folderPath,
      "mission",
      "name: M1 - Auth\nstatus: draft\ndescription: d\nacceptance_criteria:\n  - text: ships\n    done: false\ndocuments: []\nrole: python-dev\n",
    );
    rawYaml(
      b.folderPath,
      "bug",
      "name: B1 - Broken\nstatus: draft\nseverity: major\ndescription: d\nacceptance_criteria:\n  - text: no regress\n    done: false\n",
    );

    const messages = misplacedFindings();
    expect(messages).toHaveLength(3);
    expect(messages.join("\n")).toContain("tokenomics");
    expect(messages.join("\n")).toContain("role");
    expect(messages.join("\n")).toContain("acceptance_criteria");
  });

  it("does not report a custom key the schema simply does not know", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    rawYaml(
      t.folderPath,
      "task",
      "name: T1.1 - JWT\nstatus: draft\ndescription: d\nacceptance_criteria:\n  - text: jwt\n    done: false\nowner: alice\nlinked_pr: 'https://example.com/1'\n",
    );

    expect(misplacedFindings()).toEqual([]);
  });

  it("does not report a field the kind legitimately owns", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    createTask(boardRoot, m.id, { name: "T1.1 - JWT", role: "python-dev", acceptanceCriteria: "- [ ] jwt" });
    rawYaml(
      c.folderPath,
      "campaign",
      "name: Q3 Rollout\nstatus: draft\ntarget: ship it\ndescription: d\nacceptance_criteria: []\ndocuments:\n  - label: Spec\n    target: docs/spec.md\n",
    );

    expect(misplacedFindings()).toEqual([]);
  });
});
