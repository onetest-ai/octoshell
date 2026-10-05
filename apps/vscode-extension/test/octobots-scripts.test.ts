/**
 * Smoke tests for the installed octobots pack scripts, exercised against the on-disk YAML board.
 * Fixtures are built with @octoshell/board's write functions (so entity folders/ids are valid), then
 * each script is run via spawnSync and its effect asserted in a fresh BoardModel or the child's own
 * `<kind>.yaml`. Children are folder-derived — no parent projection is ever written or read.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BoardModel, createCampaign, createMission, createTask, createBug } from "@octoshell/board";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const SCRIPTS = join(__dirname, "..", "resources", "octobots-pack", "skill", "mission-planner", "scripts");
function run(script: string, args: string[], cwd: string): { out: string; code: number } {
  const result = spawnSync("node", [join(SCRIPTS, script), ...args], { cwd, encoding: "utf8" });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const code = result.status ?? 1;
  return { out, code };
}

// projectDir is the project root (parent of .octobots); boardRoot = projectDir/.octobots
let projectDir: string;
let boardRoot: string;
function board(): BoardModel {
  const b = new BoardModel(boardRoot);
  b.rebuild();
  return b;
}

// `mkdtempClean` is called from inside `beforeEach`, which runs within the current test's
// context (vitest sets the active test before running its `beforeEach` chain), so the
// `onTestFinished` cleanup it registers still fires for the right test — see fixtures/tmpdir.ts.
beforeEach(() => {
  projectDir = mkdtempClean("octobots-scripts-");
  boardRoot = join(projectDir, ".octobots");
});

describe("validate.js", () => {
  it("passes a well-formed mission (descriptive name + acceptance criterion)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Ship it", acceptanceCriteria: "- [ ] one\n- [x] two" });
    expect(run("validate.js", [join(boardRoot, m.folderPath, "mission.yaml")], projectDir).code).toBe(0);
  });

  it("rejects a placeholder task name like 'T1' (exit 1)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] a" });
    const t = createTask(boardRoot, m.id, { name: "T1", acceptanceCriteria: "- [ ] does the thing" });
    const r = run("validate.js", [join(boardRoot, t.folderPath, "task.yaml")], projectDir);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain("placeholder");
  });

  it("rejects a task with no acceptance criteria (exit 1)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] a" });
    const t = createTask(boardRoot, m.id, { name: "Wire up auth" });
    const r = run("validate.js", [join(boardRoot, t.folderPath, "task.yaml")], projectDir);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain("acceptance criteria");
  });

  it("passes a well-formed task (descriptive name + acceptance criterion)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] a" });
    const t = createTask(boardRoot, m.id, { name: "Add JWT validation to /login", acceptanceCriteria: "- [ ] rejects an expired token" });
    expect(run("validate.js", [join(boardRoot, t.folderPath, "task.yaml")], projectDir).code).toBe(0);
  });

  it("accepts the `<id> - name` title format (id prefix + descriptive name)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] a" });
    const t = createTask(boardRoot, m.id, { name: "T3.1 - Add JWT validation to /login", acceptanceCriteria: "- [ ] rejects expired tokens" });
    expect(run("validate.js", [join(boardRoot, t.folderPath, "task.yaml")], projectDir).code).toBe(0);
  });

  it("passes a mission-less campaign (children are folder-derived, none required)", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    expect(run("validate.js", [join(boardRoot, c.folderPath, "campaign.yaml")], projectDir).code).toBe(0);
  });

  it("exits 2 when the entity file is missing", () => {
    expect(run("validate.js", [join(boardRoot, "nope.yaml")], projectDir).code).toBe(2);
  });
});

describe("add-doc.js", () => {
  let campaignYaml: string;
  beforeEach(() => {
    const c = createCampaign(boardRoot, { name: "C" });
    campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
  });

  it("adds a { label, target } entry to the campaign's documents list", () => {
    const r = run("add-doc.js", [campaignYaml, "M1 spec", "docs/superpowers/specs/foo.md"], projectDir);
    expect(r.code).toBe(0);
    const text = readFileSync(campaignYaml, "utf8");
    expect(text).toContain("label: M1 spec");
    expect(text).toContain("target: docs/superpowers/specs/foo.md");
  });

  it("appends a second link without dropping the first", () => {
    run("add-doc.js", [campaignYaml, "Spec", "docs/a.md"], projectDir);
    run("add-doc.js", [campaignYaml, "Plan", "docs/b.md"], projectDir);
    const text = readFileSync(campaignYaml, "utf8");
    expect(text).toContain("target: docs/a.md");
    expect(text).toContain("target: docs/b.md");
  });

  it("is idempotent on the target (no duplicate)", () => {
    run("add-doc.js", [campaignYaml, "Spec", "docs/a.md"], projectDir);
    const r = run("add-doc.js", [campaignYaml, "Renamed", "docs/a.md"], projectDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already present");
    expect(readFileSync(campaignYaml, "utf8").match(/docs\/a\.md/g)).toHaveLength(1);
  });

  it("accepts a mission entity (documents attach to campaigns and missions)", () => {
    const c = createCampaign(boardRoot, { name: "C2" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const missionYaml = join(boardRoot, m.folderPath, "mission.yaml");
    const r = run("add-doc.js", [missionYaml, "Plan", "docs/plan.md"], projectDir);
    expect(r.code).toBe(0);
    expect(readFileSync(missionYaml, "utf8")).toContain("target: docs/plan.md");
  });

  it("rejects a task entity (documents attach to campaigns and missions only)", () => {
    const c = createCampaign(boardRoot, { name: "C3" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - A task" });
    const r = run("add-doc.js", [join(boardRoot, t.folderPath, "task.yaml"), "X", "docs/x.md"], projectDir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("campaigns and missions");
  });
});

describe("add-task.js", () => {
  let missionDir: string;
  let missionId: string;
  beforeEach(() => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    missionDir = join(boardRoot, m.folderPath);
    missionId = m.id;
  });

  it("creates a folder-backed task the BoardModel parses (no parent projection)", () => {
    const r = run("add-task.js", [missionDir, "Wire the auth flow", "--role", "tech-lead"], projectDir);
    expect(r.code).toBe(0);
    const taskYaml = join(missionDir, "tasks", "wire-the-auth-flow", "task.yaml");
    expect(existsSync(taskYaml)).toBe(true);
    const yaml = readFileSync(taskYaml, "utf8");
    expect(yaml).toContain("name: Wire the auth flow");
    expect(yaml).toContain("role: tech-lead");
    // The mission is never touched — no parent projection of the task.
    expect(readFileSync(join(missionDir, "mission.yaml"), "utf8")).not.toContain("Wire the auth flow");

    const tasks = board().listTasks(missionId);
    expect(tasks.some((t) => t.name === "Wire the auth flow")).toBe(true);
  });

  it("writes no role field when --role is absent", () => {
    run("add-task.js", [missionDir, "Build UI"], projectDir);
    expect(readFileSync(join(missionDir, "tasks", "build-ui", "task.yaml"), "utf8")).not.toContain("role:");
  });
});

describe("add-bug.js", () => {
  it("creates a folder-backed bug carrying its own severity (no parent projection)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const missionDir = join(boardRoot, m.folderPath);
    run("add-bug.js", [missionDir, "T6 - agent-creator is a SKILL not an agent", "--severity", "blocker"], projectDir);
    const bugYaml = join(missionDir, "bugs", "t6-agent-creator-is-a-skill-not-an-agent", "bug.yaml");
    const yaml = readFileSync(bugYaml, "utf8");
    expect(yaml).toContain("name: T6 - agent-creator is a SKILL not an agent");
    expect(yaml).toContain("severity: blocker");
    // The mission is never touched.
    expect(readFileSync(join(missionDir, "mission.yaml"), "utf8")).not.toContain("agent-creator");

    const bug = board().listBugs({ missionId: m.id })[0]!;
    expect(bug.title).toBe("T6 - agent-creator is a SKILL not an agent");
    expect(bug.severity).toBe("blocker");
  });
});

describe("set-criterion.js", () => {
  let missionDir: string;
  beforeEach(() => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] one\n- [ ] two" });
    missionDir = join(boardRoot, m.folderPath);
  });
  it("adds a criterion to the entity's acceptance_criteria list", () => {
    run("set-criterion.js", [join(missionDir, "mission.yaml"), "add", "three"], projectDir);
    expect(readFileSync(join(missionDir, "mission.yaml"), "utf8")).toContain("text: three");
  });
  it("checks and unchecks by 1-based index", () => {
    run("set-criterion.js", [join(missionDir, "mission.yaml"), "check", "1"], projectDir);
    let yaml = readFileSync(join(missionDir, "mission.yaml"), "utf8");
    expect(yaml).toMatch(/text: one\n\s*done: true/);
    run("set-criterion.js", [join(missionDir, "mission.yaml"), "uncheck", "1"], projectDir);
    yaml = readFileSync(join(missionDir, "mission.yaml"), "utf8");
    expect(yaml).toMatch(/text: one\n\s*done: false/);
  });
});

describe("set-status.js", () => {
  let missionDir: string;
  let taskId: string;
  beforeEach(() => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const t = createTask(boardRoot, m.id, { name: "Existing task" });
    missionDir = join(boardRoot, m.folderPath);
    taskId = t.id;
  });

  it("sets the status in the task's own yaml", () => {
    const r = run("set-status.js", [missionDir, "Existing task", "done"], projectDir);
    expect(r.code).toBe(0);
    expect(board().getTask(taskId)!.status).toBe("done");
  });

  it("is idempotent: re-setting replaces the status", () => {
    run("set-status.js", [missionDir, "Existing task", "done"], projectDir);
    run("set-status.js", [missionDir, "Existing task", "active"], projectDir);
    expect(board().getTask(taskId)!.status).toBe("executing");
  });

  it("accepts a multi-word state like 'awaiting approval'", () => {
    const r = run("set-status.js", [missionDir, "Existing task", "awaiting", "approval"], projectDir);
    expect(r.code).toBe(0);
    expect(board().getTask(taskId)!.status).toBe("awaitingApproval");
  });

  it("rejects an unknown state (exit 2)", () => {
    const r = run("set-status.js", [missionDir, "Existing task", "bogus"], projectDir);
    expect(r.code).toBe(2);
    expect(r.out.toLowerCase()).toContain("invalid state");
  });

  it("exits 1 when no entity matches the title", () => {
    const r = run("set-status.js", [missionDir, "No such task", "done"], projectDir);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain("no entity");
  });

  it("exits 2 when args are missing", () => {
    const r = run("set-status.js", [missionDir, "Existing task"], projectDir);
    expect(r.code).toBe(2);
    expect(r.out.toLowerCase()).toContain("usage");
  });

  it("sets a campaign's own status (self-status) when the title matches the campaign name", () => {
    const c = createCampaign(boardRoot, { name: "My Campaign" });
    const campaignDir = join(boardRoot, c.folderPath);
    const r = run("set-status.js", [campaignDir, "My Campaign", "cancelled"], projectDir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(campaignDir, "campaign.yaml"), "utf8")).toContain("status: cancelled");
  });
});

describe("list.js / show.js", () => {
  it("list.js prints the mission title from the tree", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    createMission(boardRoot, c.id, { title: "M1 - Ship" });
    const r = run("list.js", [], projectDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("M1 - Ship");
  });
  it("show.js --digest prints title and acceptance criteria", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Ship", acceptanceCriteria: "- [ ] one" });
    const r = run("show.js", [join(boardRoot, m.folderPath, "mission.yaml"), "--digest"], projectDir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("M1 - Ship");
    expect(r.out).toContain("one");
  });
});

describe("delete-bug.js", () => {
  it("trashes the bug folder (folder-derived; no parent line)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const bug = createBug(boardRoot, { campaignId: c.id }, { title: "Boom on save" });
    const bugFolder = join(boardRoot, bug.folderPath);
    expect(existsSync(bugFolder)).toBe(true);

    const r = run("delete-bug.js", [join(boardRoot, c.folderPath), "Boom on save"], projectDir);
    expect(r.code).toBe(0);
    expect(existsSync(bugFolder)).toBe(false);
    expect(board().getBug(bug.id)).toBeNull();
  });

  it("exits 1 when no matching bug exists", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    expect(run("delete-bug.js", [join(boardRoot, c.folderPath), "Nope"], projectDir).code).toBe(1);
  });
});

describe("delete-task.js", () => {
  it("trashes the task folder (folder-derived; no parent line)", () => {
    const c = createCampaign(boardRoot, { name: "C" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const t = createTask(boardRoot, m.id, { name: "Existing task" });
    const taskFolder = join(boardRoot, t.folderPath);
    expect(existsSync(taskFolder)).toBe(true);

    const r = run("delete-task.js", [join(boardRoot, m.folderPath), "Existing task"], projectDir);
    expect(r.code).toBe(0);
    expect(existsSync(taskFolder)).toBe(false);
    expect(board().getTask(t.id)).toBeNull();
  });
});
