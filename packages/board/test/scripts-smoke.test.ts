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
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCampaign, createMission, createTask, createBug } from "../src/write.js";
import { BoardModel } from "../src/board-model.js";

// Absolute path to the canonical (in-repo) skill scripts — the source of truth the extension
// installs into a workspace's .claude/. Resolve against the repo so the test is hermetic and does
// not depend on the pack being installed on the machine.
// From packages/board/test → ../../../apps/vscode-extension/resources/octobots-pack/skill/octobots/scripts
const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/octobots/scripts");

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

describe("set-status script", () => {
  it("sets status on a task board line", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission" });
    const _t = createTask(boardRoot, m.id, { name: "T1.1 - My Task" });
    const missionDir = join(boardRoot, m.folderPath);

    const out = runScript("set-status.js", [missionDir, "T1.1 - My Task", "done"], projectDir);
    expect(out.trim()).toBe('set status of "T1.1 - My Task" to done');
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
  it("exits 0 for a campaign.md with a missions board line", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Campaign" });
    // Create a mission so the campaign.md gets the ## Missions section
    createMission(boardRoot, c.id, { title: "M1 - Setup" });
    const campaignMd = join(boardRoot, c.folderPath, "campaign.md");

    const out = runScript("validate.js", [campaignMd], projectDir);
    expect(out.trim()).toContain("OK");
  });

  it("exits 1 for a task missing acceptance criteria", () => {
    const c = createCampaign(boardRoot, { name: "Q3" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Mission", acceptanceCriteria: "- [ ] pass" });
    // Create a task without acceptance criteria
    const t = createTask(boardRoot, m.id, { name: "T1.1 - No AC Task" });
    const taskMd = join(boardRoot, t.folderPath, "task.md");

    let threw = false;
    try {
      runScript("validate.js", [taskMd], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(1);
    }
    expect(threw).toBe(true);
  });

  it("exits 2 when file not found", () => {
    let threw = false;
    try {
      runScript("validate.js", [join(boardRoot, "nonexistent.md")], projectDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as { status?: number }).status).toBe(2);
    }
    expect(threw).toBe(true);
  });
});
