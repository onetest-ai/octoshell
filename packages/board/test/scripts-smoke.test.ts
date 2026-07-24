/**
 * Smoke tests for the converted octobots skill scripts.
 * Each test builds a temp .octobots tree using the library (to get valid entity ids/folders),
 * then runs the target script via execFileSync and asserts the effect in a fresh BoardModel.
 *
 * The board root (passed to library functions) is at `projectDir/.octobots` — matching how
 * scripts resolve the root by walking up to find the `.octobots` directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCampaign, createMission, createTask, createBug } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

// Absolute path to the canonical (in-repo) skill scripts — the source of truth the extension
// installs into a workspace's .claude/. Resolve against the repo so the test is hermetic and does
// not depend on the pack being installed on the machine.
// From packages/board/test → ../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts
const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");

function runScript(name: string, args: string[], cwd: string): string {
  return execFileSync("node", [join(SCRIPTS, name), ...args], {
    cwd,
    encoding: "utf8",
  });
}

// projectDir is the project root (parent of .octobots); boardRoot = projectDir/.octobots
let projectDir: string;
let boardRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "scripts-smoke-"));
  boardRoot = join(projectDir, ".octobots");
  mkdirSync(boardRoot);
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("add-task script", () => {
  it("creates a task folder and board line under a mission", () => {
    const c = createCampaign(boardRoot, { name: "Test Campaign" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Test Mission", acceptanceCriteria: "- [ ] pass" });
    const missionDir = join(boardRoot, m.folderPath);

    const out = runScript("add-task.js", [missionDir, "T1.1 - My New Task"], projectDir);
    // Script appends the created folder slug, e.g. "(tasks/t1-1-my-new-task)" — assert the prefix.
    expect(out.trim()).toContain("added task: T1.1 - My New Task");

    const board = new BoardModel(boardRoot);
    board.rebuild();
    const tasks = board.listTasks(m.id);
    expect(tasks.some((t) => t.name === "T1.1 - My New Task")).toBe(true);
  });

  it("creates a task with --role flag", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const missionDir = join(boardRoot, m.folderPath);

    const out = runScript("add-task.js", [missionDir, "T1.2 - Scoped Task", "--role", "dev"], projectDir);
    expect(out.trim()).toContain("added task: T1.2 - Scoped Task");

    const board = new BoardModel(boardRoot);
    board.rebuild();
    const tasks = board.listTasks(m.id);
    expect(tasks.some((t) => t.name === "T1.2 - Scoped Task")).toBe(true);
  });

  it("exits 2 with missing args", () => {
    let threw = false;
    try {
      runScript("add-task.js", [], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(2);
    }
    expect(threw).toBe(true);
  });
});

describe("add-campaign script", () => {
  it("creates a campaign.yaml the BoardModel parses, that validates", () => {
    const out = runScript("add-campaign.js", ["Q3 Rollout", "--description", "Ship it", "--target", "Done"], projectDir);
    expect(out.trim()).toContain("added campaign: Q3 Rollout");

    const campaignYaml = join(boardRoot, "campaigns", "q3-rollout", "campaign.yaml");
    const yaml = readFileSync(campaignYaml, "utf8");
    expect(yaml).toContain("name: Q3 Rollout");
    expect(yaml).toContain("description: Ship it");
    expect(yaml).toContain("target: Done");
    // Children are folder-derived — a campaign.yaml never enumerates its missions.
    expect(yaml).not.toContain("Missions");

    const board = new BoardModel(boardRoot);
    board.rebuild();
    expect(board.listCampaigns().some((c) => c.name === "Q3 Rollout")).toBe(true);

    // A mission-less campaign scaffolded by the script is well-formed.
    expect(runScript("validate.js", [campaignYaml], projectDir)).toContain("OK");
  });

  it("exits 2 with missing args", () => {
    let threw = false;
    try {
      runScript("add-campaign.js", [], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(2);
    }
    expect(threw).toBe(true);
  });
});

describe("add-mission script", () => {
  it("creates a folder-derived mission under a campaign (no parent projection)", () => {
    runScript("add-campaign.js", ["Camp"], projectDir);
    const campaignDir = join(boardRoot, "campaigns", "camp");

    const out = runScript("add-mission.js", [campaignDir, "M1 - First mission", "--description", "Do things"], projectDir);
    expect(out.trim()).toContain("added mission: M1 - First mission");

    // The mission is folder-derived — its own mission.yaml carries its fields, and the campaign.yaml
    // is NOT touched (never enumerates missions).
    const missionYaml = readFileSync(join(campaignDir, "missions", "m1-first-mission", "mission.yaml"), "utf8");
    expect(missionYaml).toContain("name: M1 - First mission");
    expect(missionYaml).toContain("description: Do things");
    expect(readFileSync(join(campaignDir, "campaign.yaml"), "utf8")).not.toContain("First mission");

    const board = new BoardModel(boardRoot);
    board.rebuild();
    const c = board.listCampaigns()[0]!;
    expect(board.listMissions(c.id).some((m) => m.title === "M1 - First mission")).toBe(true);

    // Same title again → deduped slug, not a clobbered folder.
    runScript("add-mission.js", [campaignDir, "M1 - First mission"], projectDir);
    expect(existsSync(join(campaignDir, "missions", "m1-first-mission-2"))).toBe(true);
  });

  it("exits 2 with missing args", () => {
    let threw = false;
    try {
      runScript("add-mission.js", [], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(2);
    }
    expect(threw).toBe(true);
  });
});

describe("add-doc script — edits the campaign's documents list", () => {
  it("attaches a { label, target } link to a freshly-scripted campaign.yaml", () => {
    runScript("add-campaign.js", ["Camp"], projectDir);
    const campaignYaml = join(boardRoot, "campaigns", "camp", "campaign.yaml");
    // A fresh campaign.yaml has an empty documents list.
    expect(readFileSync(campaignYaml, "utf8")).toContain("documents: []");

    runScript("add-doc.js", [campaignYaml, "M1 spec", "docs/spec.md"], projectDir);

    const text = readFileSync(campaignYaml, "utf8");
    expect(text).toContain("label: M1 spec");
    expect(text).toContain("target: docs/spec.md");

    // The campaign.yaml still parses cleanly into a BoardModel.
    const board = new BoardModel(boardRoot);
    board.rebuild();
    expect(board.listCampaigns().some((c) => c.name === "Camp")).toBe(true);

    // Idempotent on target.
    expect(runScript("add-doc.js", [campaignYaml, "renamed", "docs/spec.md"], projectDir)).toContain("already present");
    expect(runScript("validate.js", [campaignYaml], projectDir)).toContain("OK");
  });
});

describe("set-status script", () => {
  it("sets status on a task board line", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - My Task" });
    const missionDir = join(boardRoot, m.folderPath);

    const out = runScript("set-status.js", [missionDir, "T1.1 - My Task", "done"], projectDir);
    expect(out.trim()).toBe('set status of "T1.1 - My Task" to done');

    // Status lives in the task's OWN yaml — the BoardModel reads it back.
    const board = new BoardModel(boardRoot);
    board.rebuild();
    expect(board.getTask(t.id)!.status).toBe("done");
  });

  it("exits 1 on unknown entity title", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const missionDir = join(boardRoot, m.folderPath);

    let threw = false;
    try {
      runScript("set-status.js", [missionDir, "Nonexistent Task", "done"], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(1);
    }
    expect(threw).toBe(true);
  });
});

describe("delete-task script", () => {
  it("removes the task from the board and trashes its folder", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - Delete Me" });
    const missionDir = join(boardRoot, m.folderPath);
    const taskFolder = join(boardRoot, t.folderPath);

    expect(existsSync(taskFolder)).toBe(true);

    const out = runScript("delete-task.js", [missionDir, "T1.1 - Delete Me"], projectDir);
    expect(out.trim()).toContain("deleted task: T1.1 - Delete Me");

    expect(existsSync(taskFolder)).toBe(false);

    const board = new BoardModel(boardRoot);
    board.rebuild();
    expect(board.getTask(t.id)).toBeNull();
  });

  it("exits 1 when task not found", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const missionDir = join(boardRoot, m.folderPath);

    let threw = false;
    try {
      runScript("delete-task.js", [missionDir, "No Such Task"], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(1);
    }
    expect(threw).toBe(true);
  });
});

describe("validate script", () => {
  it("exits 0 for a campaign.yaml", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Campaign" });
    createMission(boardRoot, c.id, { title: "M1 - Setup" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");

    const out = runScript("validate.js", [campaignYaml], projectDir);
    expect(out.trim()).toContain("OK");
  });

  it("exits 1 for a task missing acceptance criteria", () => {
    const c = createCampaign(boardRoot, { name: "Q3" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] pass" });
    // Create a task without acceptance criteria
    const t = createTask(boardRoot, m.id, { name: "T1.1 - No AC Task" });
    const taskYaml = join(boardRoot, t.folderPath, "task.yaml");

    let threw = false;
    try {
      runScript("validate.js", [taskYaml], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(1);
    }
    expect(threw).toBe(true);
  });

  it("exits 2 when file not found", () => {
    let threw = false;
    try {
      runScript("validate.js", [join(boardRoot, "nonexistent.yaml")], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(2);
    }
    expect(threw).toBe(true);
  });
});

describe("workflow scripts", () => {
  /** Slug of a folderPath's last segment (the scripts take slugs, the library returns paths). */
  function slugOf(folderPath: string): string {
    return folderPath.split("/").pop()!;
  }

  it("add-workflow.js scaffolds a workflow the BoardModel parses cleanly", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    runScript("add-workflow.js", ["--campaign", slugOf(c.folderPath), "--name", "Ship Missions"], projectDir);

    const board = new BoardModel(boardRoot);
    board.rebuild();
    const [wf] = board.listWorkflows({ campaignId: c.id });
    expect(wf).toBeDefined();
    expect(wf!.name).toBe("ship-missions");
    expect(wf!.parseError).toBeNull();
    expect(wf!.phases).toHaveLength(1);
  });

  it("add-workflow.js refuses a second workflow on a mission", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const cs = slugOf(c.folderPath);
    const ms = slugOf(m.folderPath);
    runScript("add-workflow.js", ["--campaign", cs, "--mission", ms, "--name", "build-tasks"], projectDir);
    expect(() =>
      runScript("add-workflow.js", ["--campaign", cs, "--mission", ms, "--name", "other"], projectDir),
    ).toThrow();
  });

  it("set-step.js adds a step the BoardModel then reports", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const cs = slugOf(c.folderPath);
    runScript("add-workflow.js", ["--campaign", cs, "--name", "ship"], projectDir);
    const wfDir = join(".octobots", "campaigns", cs, "workflows", "ship");
    runScript(
      "set-step.js",
      ["--workflow", wfDir, "--phase", "Build", "--id", "s2", "--agent", "impl", "--label", "Build it", "--parallel", "b"],
      projectDir,
    );

    const board = new BoardModel(boardRoot);
    board.rebuild();
    const [wf] = board.listWorkflows({ campaignId: c.id });
    expect(wf!.parseError).toBeNull();
    const build = wf!.phases.find((p) => p.title === "Build");
    expect(build!.steps[0]!.agent).toBe("impl");
    expect(build!.steps[0]!.parallel).toBe("b");
  });

  it("add-run.js drives lastRunStatus", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const cs = slugOf(c.folderPath);
    runScript("add-workflow.js", ["--campaign", cs, "--name", "ship"], projectDir);
    const wfDir = join(".octobots", "campaigns", cs, "workflows", "ship");
    runScript("add-run.js", ["--workflow", wfDir, "--status", "done", "--summary", "4 agents", "--at", "2026-07-23"], projectDir);
    runScript("add-run.js", ["--workflow", wfDir, "--status", "failed", "--summary", "review", "--at", "2026-07-24"], projectDir);

    const board = new BoardModel(boardRoot);
    board.rebuild();
    expect(board.listWorkflows({ campaignId: c.id })[0]!.lastRunStatus).toBe("failed");
  });

  it("validate.js fails a workflow whose meta.name disagrees with its folder", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const cs = slugOf(c.folderPath);
    runScript("add-workflow.js", ["--campaign", cs, "--name", "ship"], projectDir);
    const jsPath = join(boardRoot, "campaigns", cs, "workflows", "ship", "workflow.js");
    writeFileSync(jsPath, readFileSync(jsPath, "utf8").replace('"ship"', '"other"'), "utf8");

    expect(() =>
      runScript("validate.js", [join(".octobots", "campaigns", cs, "workflows", "ship", "workflow.js")], projectDir),
    ).toThrow();
  });

  it("validate.js passes a well-formed workflow", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const cs = slugOf(c.folderPath);
    runScript("add-workflow.js", ["--campaign", cs, "--name", "ship"], projectDir);
    const out = runScript(
      "validate.js",
      [join(".octobots", "campaigns", cs, "workflows", "ship", "workflow.js")],
      projectDir,
    );
    expect(out).toMatch(/^OK /);
  });
});
