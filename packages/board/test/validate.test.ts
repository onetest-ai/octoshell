import { describe, it, expect } from "vitest";
import { validateBriefText, isPlaceholderName } from "../src/validate.js";
import { renderManagedBlock } from "../src/managed-block.js";

it("flags a mission with no acceptance criteria", () => {
  const md =
    renderManagedBlock("mission", { name: "M1 - Real Name", description: "d", acceptanceCriteria: "" }, [], "planner") +
    "## Tasks\n_(none yet)_\n";
  const findings = validateBriefText("mission", md, "mission.md");
  expect(findings.some((f) => /acceptance criterion/i.test(f.message))).toBe(true);
});

it("flags a placeholder title", () => {
  expect(isPlaceholderName("T1")).toBe(true);
  expect(isPlaceholderName("Task 3")).toBe(true);
  expect(isPlaceholderName("Add JWT validation")).toBe(false);
});

describe("isPlaceholderName", () => {
  it("treats empty string as placeholder", () => {
    expect(isPlaceholderName("")).toBe(true);
  });

  it("treats short letter+number sequences as placeholder", () => {
    expect(isPlaceholderName("M3")).toBe(true);
    expect(isPlaceholderName("T5.5")).toBe(true);
    expect(isPlaceholderName("TSK12")).toBe(true);
    expect(isPlaceholderName("C2")).toBe(true);
  });

  it("treats bare numbers as placeholder", () => {
    expect(isPlaceholderName("1")).toBe(true);
    expect(isPlaceholderName("42")).toBe(true);
  });

  it("treats generic words as placeholder", () => {
    expect(isPlaceholderName("mission")).toBe(true);
    expect(isPlaceholderName("Campaign")).toBe(true);
    expect(isPlaceholderName("Bug")).toBe(true);
    expect(isPlaceholderName("Untitled")).toBe(true);
    expect(isPlaceholderName("TBD")).toBe(true);
  });

  it("accepts descriptive names", () => {
    expect(isPlaceholderName("M3 - Skills workspace")).toBe(false);
    expect(isPlaceholderName("T3.1 - Add JWT validation")).toBe(false);
    expect(isPlaceholderName("Fix login redirect bug")).toBe(false);
  });
});

describe("validateBriefText", () => {
  const validMission = (overrides?: { name?: string; ac?: string; includeTasksSection?: boolean }) => {
    const name = overrides?.name ?? "M1 - Real Name";
    const ac = overrides?.ac ?? "- [ ] Something verifiable";
    const includeTasksSection = overrides?.includeTasksSection !== false;
    const md =
      renderManagedBlock("mission", { name, description: "desc", acceptanceCriteria: ac }, [], "planner") +
      (includeTasksSection ? "## Tasks\n_(none yet)_\n" : "");
    return md;
  };

  it("returns no findings for a fully valid mission", () => {
    const md = validMission();
    expect(validateBriefText("mission", md, "mission.md")).toHaveLength(0);
  });

  it("flags missing boundary comment", () => {
    // Build a doc without the managed block (no boundary comment)
    const md = `# M1 - Real Name\n\n## Description\ndesc\n\n## Acceptance Criteria\n- [ ] criterion\n\n## Tasks\n_(none yet)_\n`;
    const findings = validateBriefText("mission", md, "mission.md");
    expect(findings.some((f) => /boundary|auto-generated/i.test(f.message))).toBe(true);
  });

  it("flags a missing agent-owned section (## Tasks / ## Missions / ## Bugs)", () => {
    // Mission with no ## Tasks section below the boundary comment
    const md =
      renderManagedBlock("mission", { name: "M1 - Real Name", description: "d", acceptanceCriteria: "- [ ] x" }, [], "planner");
    const findings = validateBriefText("mission", md, "mission.md");
    expect(findings.some((f) => /## Tasks|## Missions|## Bugs|agent-owned/i.test(f.message))).toBe(true);
  });

  it("flags a placeholder mission title", () => {
    const md = validMission({ name: "M1" });
    const findings = validateBriefText("mission", md, "mission.md");
    expect(findings.some((f) => /placeholder|id/i.test(f.message))).toBe(true);
  });

  it("flags a task with a bare-id name under ## Tasks in a mission", () => {
    const md =
      renderManagedBlock("mission", { name: "M1 - Real Name", description: "d", acceptanceCriteria: "- [ ] x" }, [], "planner") +
      "## Tasks\n- T2\n- T3.1 - Add real feature\n";
    const findings = validateBriefText("mission", md, "mission.md");
    expect(findings.some((f) => /task.*id|id.*task|bare.*id/i.test(f.message))).toBe(true);
    // "T3.1 - Add real feature" is not a placeholder — should not produce extra finding for it
    const taskFindings = findings.filter((f) => /task.*id|id.*task|bare.*id/i.test(f.message));
    expect(taskFindings.length).toBe(1);
  });

  it("returns no findings for a valid campaign", () => {
    const md =
      renderManagedBlock(
        "campaign",
        { name: "C1 - My Campaign", description: "desc", acceptanceCriteria: "", target: "goal", status: "draft" },
        [],
        "orchestrator",
      ) + "## Missions\n_(none yet)_\n";
    expect(validateBriefText("campaign", md, "campaign.md")).toHaveLength(0);
  });

  it("returns no findings for a valid bug", () => {
    const md =
      renderManagedBlock(
        "bug",
        {
          name: "B1 - Login crashes on empty password",
          description: "desc",
          acceptanceCriteria: "",
          severity: "critical",
        },
        [],
        "planner",
      ) + "## Bugs\n_(none yet)_\n";
    expect(validateBriefText("bug", md, "bug.md")).toHaveLength(0);
  });

  it("all findings carry correct mdPath and severity=error", () => {
    const md = `# T1\n## Description\nd\n`;
    const findings = validateBriefText("task", md, "/some/path/task.md");
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.mdPath).toBe("/some/path/task.md");
      expect(f.severity).toBe("error");
      expect(f.kind).toBe("task");
    }
  });
});
