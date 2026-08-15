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

  /**
   * Findings for a single workflow.js body, isolated from the campaign/mission scaffolding
   * `wfBoard` needs to exercise `validateBoard`. `validateBoard` is the only exported entry point
   * that reaches `validateWorkflow`, so every case still goes through a real board tree — this
   * just fixes the folder slug at "w" and hides the boilerplate every case here would repeat.
   */
  function findingsFor(src: string) {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
      "campaigns/alpha/workflows/w/workflow.js": src,
    });
    return validateBoard(root).filter((f) => f.kind === "workflow");
  }

  it("reports a missing meta export", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD,
      "campaigns/alpha/workflows/w/workflow.js": "const x = 1\n",
    });
    const messages = validateBoard(root).map((f) => f.message);
    expect(messages.some((m) => /export const meta/.test(m))).toBe(true);
  });

  it("does not treat a folder without workflow.js as a workflow", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/w/workflow.md": WF_MD, // legacy .md-only folder, no script
    });
    expect(validateBoard(root).filter((f) => f.kind === "workflow")).toEqual([]);
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

  // The declared graph (duplicate step ids, dangling dependsOn, a parallel group split across
  // phases) can no longer be wrong on its own terms — it is GENERATED from the body, not
  // hand-authored — so validate no longer checks it. `meta.phases.length === 0` survives: a
  // workflow with no phases at all is still a real problem no extraction can paper over.
  it("reports no phases", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/none/workflow.md": WF_MD,
      "campaigns/alpha/workflows/none/workflow.js": "export const meta = { name: 'none', phases: [] }\n",
    });
    const messages = validateBoard(root).map((f) => f.message).join("\n");
    expect(messages).toMatch(/has no phases/);
  });

  // A mission has THREE distinct execution loops, not one — implementation
  // iterates its tasks while building, testing iterates test cases and re-runs
  // after every later mission, fixing iterates open bugs. They take different
  // inputs, apply different gates, and run at different times. `BoardModel` has
  // always stored `workflowsByMission` as a `string[]`, keyed identically to the
  // campaign case; only this validator and the pack scripts ever claimed one.
  // See onetest-ai/octoshell#60.
  it("accepts a mission with several workflows — one per execution loop", () => {
    const good = "export const meta = { name: 'NAME', phases: [{ title: 'P', steps: [{ id: 's1', agent: 'a', label: 'l' }] }] }\n";
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/missions/m1/mission.md": MISSION,
      "campaigns/alpha/missions/m1/workflows/implementation/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/implementation/workflow.js": good.replace("NAME", "implementation"),
      "campaigns/alpha/missions/m1/workflows/testing/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/testing/workflow.js": good.replace("NAME", "testing"),
      "campaigns/alpha/missions/m1/workflows/fixing/workflow.md": WF_MD,
      "campaigns/alpha/missions/m1/workflows/fixing/workflow.js": good.replace("NAME", "fixing"),
    });
    const messages = validateBoard(root).map((f) => f.message).join("\n");
    expect(messages).not.toMatch(/more than one workflow/);
    // …and each of the three still gets validated on its own merits, so dropping
    // the cardinality rule did not stop the validator looking inside them.
    expect(messages).not.toMatch(/workflow/);
  });

  it("passes a well-formed workflow", () => {
    const root = wfBoard({
      "campaigns/alpha/campaign.md": CAMPAIGN,
      "campaigns/alpha/workflows/ok/workflow.md": WF_MD,
      "campaigns/alpha/workflows/ok/workflow.js":
        "export const meta = { name: 'ok', phases: [{ title: 'P', steps: [{ id: 'p-1', label: 'l', agent: 'a' }] }] }\n" +
        "phase('P')\nawait agent(p, { phase: 'P', label: 'l', agentType: 'a' })\n",
    });
    expect(validateBoard(root).filter((f) => f.kind === "workflow")).toEqual([]);
  });

  it("fails when meta disagrees with the body", () => {
    const src = `export const meta = {
  name: "w",
  description: "",
  phases: [{ title: "Build", steps: [{ id: "build-1", label: "stale", agent: "ios-dev" }] }],
}
phase('Build')
await agent(p, { phase: 'Build', label: 'fresh', agentType: 'ios-dev' })
`;
    expect(findingsFor(src)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("meta is out of date") }),
    );
  });

  it("fails when the body does not parse", () => {
    const src = `export const meta = { name: "w", description: "", phases: [] }
phase('Build'
`;
    expect(findingsFor(src)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("body does not parse") }),
    );
  });

  it("fails when an agent() call names no agentType", () => {
    const src = `export const meta = {
  name: "w",
  description: "",
  phases: [{ title: "Build", steps: [{ id: "build-1", label: "build" }] }],
}
phase('Build')
await agent(p, { phase: 'Build', label: 'build' })
`;
    expect(findingsFor(src)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("no agentType") }),
    );
  });

  it("no longer objects to a phase with no steps", () => {
    const src = `export const meta = {
  name: "w",
  description: "",
  phases: [{ title: "Run", steps: [] }],
}
phase('Run')
`;
    expect(findingsFor(src)).toEqual([]);
  });
});
