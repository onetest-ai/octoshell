import { describe, it, expect } from "vitest";
import { validateBriefText, isPlaceholderName, validateBoard } from "../src/validate.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

describe("workflow validation", () => {
  function wfBoard(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "wf-val-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, ".octobots", rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return root;
  }

  const CAMPAIGN = "# Alpha\n\n## Description\nA real description here.\n\n## Acceptance Criteria\n- [ ] ships\n";
  const MISSION = "# M1 - Auth\n\n## Description\nA real description here.\n\n## Acceptance Criteria\n- [ ] ships\n";
  const WF_MD = "# w\n\n## Description\nA workflow.\n";

  it("reports a missing meta export", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
      "campaigns/alpha/workflows/w/workflow.js": "const x = 1\n",
    });
    const messages = validateBoard(root).map((f) => f.message);
    expect(messages.some((m) => /export const meta/.test(m))).toBe(true);
  });

  it("reports a missing workflow.js", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
    });
    expect(validateBoard(root).some((f) => /workflow\.js is missing/.test(f.message))).toBe(true);
  });

  it("reports a name that does not match the folder slug", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
      "campaigns/alpha/workflows/w/workflow.js":
        "export const meta = { name: 'other', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\n",
    });
    expect(validateBoard(root).some((f) => /does not match its folder/.test(f.message))).toBe(true);
  });

  it("reports no phases, empty phases, duplicate ids, unknown dependsOn and split parallel groups", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/none/workflow.md": WF_MD,
      "campaigns/alpha/workflows/none/workflow.js": "export const meta = { name: 'none', phases: [] }\n",
      "campaigns/alpha/workflows/empty/workflow.md": WF_MD,
      "campaigns/alpha/workflows/empty/workflow.js":
        "export const meta = { name: 'empty', phases: [{ title: 'P', steps: [] }] }\n",
      "campaigns/alpha/workflows/dup/workflow.md": WF_MD,
      "campaigns/alpha/workflows/dup/workflow.js":
        "export const meta = { name: 'dup', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }, { id: 's1', agent: 'b', label: 'm' }] }] }\n",
      "campaigns/alpha/workflows/dep/workflow.md": WF_MD,
      "campaigns/alpha/workflows/dep/workflow.js":
        "export const meta = { name: 'dep', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l', dependsOn: ['nope'] }] }] }\n",
      "campaigns/alpha/workflows/par/workflow.md": WF_MD,
      "campaigns/alpha/workflows/par/workflow.js":
        "export const meta = { name: 'par', phases: [{ title: 'A', steps: [{ id: 's1', agent: 'a', label: 'l', parallel: 'g' }] }, { title: 'B', steps: [{ id: 's2', agent: 'b', label: 'm', parallel: 'g' }] }] }\n",
    });
    const messages = validateBoard(root).map((f) => f.message).join("\n");
    expect(messages).toMatch(/has no phases/);
    expect(messages).toMatch(/phase "P" has no steps/);
    expect(messages).toMatch(/duplicate step id "s1"/);
    expect(messages).toMatch(/dependsOn "nope"/);
    expect(messages).toMatch(/parallel group "g" spans more than one phase/);
  });

  it("reports a mission with more than one workflow", () => {
    const good = "export const meta = { name: 'NAME', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\n";
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/missions/m1/mission.md": MISSION,
      "campaigns/alpha/missions/m1/workflows/a/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/a/workflow.js": good.replace("NAME", "a"),
      "campaigns/alpha/missions/m1/workflows/b/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/b/workflow.js": good.replace("NAME", "b"),
    });
    expect(validateBoard(root).some((f) => /more than one workflow/.test(f.message))).toBe(true);
  });

  it("passes a well-formed workflow", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/ok/workflow.md": WF_MD,
      "campaigns/alpha/workflows/ok/workflow.js":
        "export const meta = { name: 'ok', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\nphase('P')\n",
    });
    expect(validateBoard(root).filter((f) => f.kind === "workflow")).toEqual([]);
  });
});
