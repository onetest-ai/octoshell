/**
 * End-to-end scenarios for the octobots pack CLI scripts an agent actually runs: filing and closing
 * bugs, reading the board, and every guard that stops a malformed edit from reaching disk.
 *
 * The scripts are the ONLY sanctioned way to change a board, so their refusals matter as much as
 * their writes — a guard that silently passes is how a bad edit becomes lost data. Each script runs
 * as a real subprocess and the effect is asserted through a rebuilt BoardModel wherever the board
 * model can see it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCampaign, createMission, createTask, createBug } from "../src/write.js";
import { loadEntity, dumpEntity, type EntityFields, type EntityKind } from "../src/entity-schema.js";
import { BoardModel } from "../src/board-model.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);

function runScript(name: string, args: string[], cwd: string): string {
  return execFileSync("node", [join(SCRIPTS, name), ...args], { cwd, encoding: "utf8" });
}

function runFailing(name: string, args: string[], cwd: string): { status: number; stderr: string } {
  try {
    runScript(name, args, cwd);
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 0, stderr: e.stderr ?? "" };
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

function seed(yamlPath: string, kind: EntityKind, patch: Partial<EntityFields>): void {
  const fields = loadEntity(readFileSync(yamlPath, "utf8"));
  writeFileSync(yamlPath, dumpEntity(kind, { ...fields, ...patch }), "utf8");
}

function board(): BoardModel {
  const b = new BoardModel(boardRoot);
  b.rebuild();
  return b;
}

let projectDir: string;
let boardRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "scripts-cli-"));
  boardRoot = join(projectDir, ".octobots");
  mkdirSync(boardRoot);
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("add-bug.js — filing a defect on the board", () => {
  it("files a bug under a campaign with the default severity", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const out = runScript("add-bug.js", [join(boardRoot, c.folderPath), "B1 - Notes are wiped"], projectDir);
    expect(out).toContain("added bug: B1 - Notes are wiped");

    const bug = board().listBugs({ campaignId: c.id })[0];
    expect(bug?.title).toBe("B1 - Notes are wiped");
    expect(bug?.severity).toBe("major");
    expect(bug?.status).toBe("draft");
  });

  it("files a bug under a mission with an explicit severity", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    runScript(
      "add-bug.js",
      [join(boardRoot, m.folderPath), "B2 - Token leak", "--severity", "blocker"],
      projectDir,
    );

    const bug = board().listBugs({ missionId: m.id })[0];
    expect(bug?.title).toBe("B2 - Token leak");
    expect(bug?.severity).toBe("blocker");
  });

  it("accepts the parent's yaml file as well as its folder", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    runScript("add-bug.js", [join(boardRoot, c.folderPath, "campaign.yaml"), "B3 - Via file"], projectDir);
    expect(board().listBugs({ campaignId: c.id })[0]?.title).toBe("B3 - Via file");
  });

  it("dedupes the folder slug instead of clobbering an existing bug", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const dir = join(boardRoot, c.folderPath);
    runScript("add-bug.js", [dir, "B1 - Same title"], projectDir);
    runScript("add-bug.js", [dir, "B1 - Same title"], projectDir);

    expect(existsSync(join(dir, "bugs", "b1-same-title"))).toBe(true);
    expect(existsSync(join(dir, "bugs", "b1-same-title-2"))).toBe(true);
    expect(board().listBugs({ campaignId: c.id })).toHaveLength(2);
  });

  it("refuses an invalid severity", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const { status, stderr } = runFailing(
      "add-bug.js",
      [join(boardRoot, c.folderPath), "B1 - Bad", "--severity", "urgent"],
      projectDir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain('invalid severity "urgent"');
  });

  it("refuses a folder that is not a campaign or mission", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    const { status, stderr } = runFailing(
      "add-bug.js",
      [join(boardRoot, t.folderPath), "B1 - Under a task"],
      projectDir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("not a campaign/mission folder");
  });

  it("refuses a missing title", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    expect(runFailing("add-bug.js", [join(boardRoot, c.folderPath)], projectDir).status).toBe(2);
  });
});

describe("delete-bug.js — closing out a defect", () => {
  it("trashes the bug folder rather than hard-deleting it", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const b = createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Notes wiped" });
    const bugFolder = join(boardRoot, b.folderPath);
    expect(existsSync(bugFolder)).toBe(true);

    const out = runScript("delete-bug.js", [join(boardRoot, c.folderPath), "B1 - Notes wiped"], projectDir);
    expect(out).toContain("deleted bug: B1 - Notes wiped");

    expect(existsSync(bugFolder)).toBe(false);
    // Soft-delete: the content is recoverable under .octobots/.trash, never destroyed.
    expect(existsSync(join(boardRoot, ".trash", "b1-notes-wiped", "bug.yaml"))).toBe(true);
    expect(board().listBugs({ campaignId: c.id })).toHaveLength(0);
  });

  it("matches the title case-insensitively and leaves siblings alone", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Gone" });
    createBug(boardRoot, { campaignId: c.id }, { title: "B2 - Stays" });

    runScript("delete-bug.js", [join(boardRoot, c.folderPath), "b1 - gone"], projectDir);

    const left = board().listBugs({ campaignId: c.id });
    expect(left.map((x) => x.title)).toEqual(["B2 - Stays"]);
  });

  it("suffixes the trash folder when a bug of the same slug was already trashed", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const dir = join(boardRoot, c.folderPath);
    createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Dup" });
    runScript("delete-bug.js", [dir, "B1 - Dup"], projectDir);
    createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Dup" });
    runScript("delete-bug.js", [dir, "B1 - Dup"], projectDir);

    expect(existsSync(join(boardRoot, ".trash", "b1-dup"))).toBe(true);
    expect(existsSync(join(boardRoot, ".trash", "b1-dup-2"))).toBe(true);
  });

  it("exits 1 when no bug carries that title", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const { status, stderr } = runFailing(
      "delete-bug.js",
      [join(boardRoot, c.folderPath), "B9 - Never existed"],
      projectDir,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("no bug titled");
  });

  it("exits 2 with missing args", () => {
    expect(runFailing("delete-bug.js", [], projectDir).status).toBe(2);
  });
});

describe("list.js — reading the board tree", () => {
  it("prints campaign → mission → task with their paths", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    createTask(boardRoot, m.id, { name: "T1.1 - JWT" });

    const out = runScript("list.js", [], projectDir);
    expect(out).toContain("# Q3 Rollout");
    expect(out).toContain("- M1 - Auth");
    expect(out).toContain("T1.1 - JWT");
    expect(out).toContain(".octobots/campaigns/q3-rollout/missions/m1-auth");
  });

  it("emits a machine-readable tree with --json", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    createTask(boardRoot, m.id, { name: "T1.1 - JWT" });

    const tree = JSON.parse(runScript("list.js", ["--json"], projectDir)) as Array<{
      campaign: string;
      missions: Array<{ mission: string; tasks: Array<{ task: string }> }>;
    }>;
    expect(tree).toHaveLength(1);
    expect(tree[0]!.campaign).toBe("Q3 Rollout");
    expect(tree[0]!.missions[0]!.mission).toBe("M1 - Auth");
    expect(tree[0]!.missions[0]!.tasks[0]!.task).toBe("T1.1 - JWT");
  });

  it("says so when the board is empty", () => {
    expect(runScript("list.js", [], projectDir)).toContain("No campaigns under .octobots/.");
  });

  it("labels an entity folder with no readable name as (untitled)", () => {
    mkdirSync(join(boardRoot, "campaigns", "orphan"), { recursive: true });
    expect(runScript("list.js", [], projectDir)).toContain("(untitled)");
  });
});

describe("show.js — reading one entity", () => {
  it("prints the raw yaml by default", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout", description: "ship it" });
    const out = runScript("show.js", [join(boardRoot, c.folderPath, "campaign.yaml")], projectDir);
    expect(out).toContain("name: Q3 Rollout");
    expect(out).toContain("description: ship it");
  });

  it("resolves a folder as well as a file", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    expect(runScript("show.js", [join(boardRoot, c.folderPath)], projectDir)).toContain("name: Q3 Rollout");
  });

  it("prints a compact digest with --digest", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, {
      name: "T1.1 - JWT",
      description: "validate tokens",
      acceptanceCriteria: "- [x] jwt validated\n- [ ] expired rejected",
    });

    const out = runScript("show.js", [join(boardRoot, t.folderPath), "--digest"], projectDir);
    expect(out).toContain("T1.1 - JWT");
    expect(out).toContain("Description: validate tokens");
    expect(out).toContain("- [x] jwt validated");
    expect(out).toContain("- [ ] expired rejected");
  });

  it("surfaces the entity's notes in the digest", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
    seed(campaignYaml, "campaign", { notes: "## Decision\nNo server: files are the source of truth." });

    const out = runScript("show.js", [campaignYaml, "--digest"], projectDir);
    expect(out).toContain("Notes:");
    expect(out).toContain("No server: files are the source of truth.");
  });

  it("exits 2 for a missing path and for a non-entity file", () => {
    expect(runFailing("show.js", [join(boardRoot, "nope.yaml")], projectDir).status).toBe(2);
    const stray = join(boardRoot, "README.md");
    writeFileSync(stray, "# not an entity\n", "utf8");
    const { status, stderr } = runFailing("show.js", [stray], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("not an entity file or folder");
  });
});

describe("set-criterion.js guards", () => {
  function taskDir(): string {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] jwt validated" });
    return join(boardRoot, t.folderPath);
  }

  it("unchecks a criterion", () => {
    const dir = taskDir();
    runScript("set-criterion.js", [dir, "check", "1"], projectDir);
    runScript("set-criterion.js", [dir, "uncheck", "1"], projectDir);
    expect(loadEntity(readFileSync(join(dir, "task.yaml"), "utf8")).acceptanceCriteria).toEqual([
      { text: "jwt validated", done: false },
    ]);
  });

  it("refuses an index outside the list", () => {
    const { status, stderr } = runFailing("set-criterion.js", [taskDir(), "check", "7"], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("index out of range");
  });

  it("refuses an unknown op and an empty add", () => {
    const dir = taskDir();
    expect(runFailing("set-criterion.js", [dir, "toggle", "1"], projectDir).stderr).toContain("unknown op");
    expect(runFailing("set-criterion.js", [dir, "add", "   "], projectDir).stderr).toContain("missing text");
  });

  it("refuses a bug (bugs carry no acceptance criteria)", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const b = createBug(boardRoot, { campaignId: c.id }, { title: "B1 - Broken" });
    const { status, stderr } = runFailing(
      "set-criterion.js",
      [join(boardRoot, b.folderPath, "bug.yaml"), "add", "should not apply"],
      projectDir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("bugs have no acceptance criteria");
  });

  it("refuses a missing path and a missing op", () => {
    expect(runFailing("set-criterion.js", [join(boardRoot, "nope"), "add", "x"], projectDir).status).toBe(2);
    expect(runFailing("set-criterion.js", [taskDir()], projectDir).status).toBe(2);
  });
});

describe("set-status.js guards", () => {
  it("sets a campaign's own status from its folder", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    runScript("set-status.js", [join(boardRoot, c.folderPath), "Q3 Rollout", "executing"], projectDir);
    expect(board().getCampaign(c.id)?.status).toBe("executing");
  });

  it("maps the friendly aliases onto canonical statuses", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const dir = join(boardRoot, c.folderPath);

    runScript("set-status.js", [dir, "M1 - Auth", "active"], projectDir);
    expect(board().getMission(m.id)?.status).toBe("executing");
    runScript("set-status.js", [dir, "M1 - Auth", "awaiting", "approval"], projectDir);
    expect(board().getMission(m.id)?.status).toBe("awaitingApproval");
  });

  it("refuses an invalid state before touching disk", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
    const before = readFileSync(campaignYaml, "utf8");

    const { status, stderr } = runFailing(
      "set-status.js",
      [join(boardRoot, c.folderPath), "Camp", "nearly-done"],
      projectDir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("invalid state");
    expect(readFileSync(campaignYaml, "utf8")).toBe(before);
  });

  it("refuses a missing path and missing args", () => {
    expect(runFailing("set-status.js", [join(boardRoot, "nope"), "X", "done"], projectDir).status).toBe(2);
    expect(runFailing("set-status.js", [], projectDir).status).toBe(2);
  });
});

describe("validate.js contract checks", () => {
  it("flags a placeholder name", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1", acceptanceCriteria: "- [ ] something" });

    const { status, stderr } = runFailing("validate.js", [join(boardRoot, t.folderPath)], projectDir);
    expect(status).toBe(1);
    expect(stderr).toContain("is just an id/placeholder");
  });

  it("flags a missing name", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
    seed(campaignYaml, "campaign", { name: "" });
    expect(runFailing("validate.js", [campaignYaml], projectDir).stderr).toContain("missing a `name`");
  });

  it("validates every workflow beneath a campaign", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const slug = c.folderPath.split("/").pop()!;
    runScript("add-workflow.js", ["--campaign", slug, "--name", "ship"], projectDir);
    const jsPath = join(boardRoot, c.folderPath, "workflows", "ship", "workflow.js");
    writeFileSync(jsPath, readFileSync(jsPath, "utf8").replace('"ship"', '"drift"'), "utf8");

    const { stderr } = runFailing("validate.js", [join(boardRoot, c.folderPath)], projectDir);
    expect(stderr).toContain('workflow "ship"');
    expect(stderr).toContain("does not match its folder");
  });

  it("exits 2 for a folder holding neither an entity nor a workflow", () => {
    const empty = join(boardRoot, "campaigns", "empty");
    mkdirSync(empty, { recursive: true });
    const { status, stderr } = runFailing("validate.js", [empty], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("no entity");
  });

  it("exits 2 for a file that is not an entity or workflow", () => {
    const stray = join(boardRoot, "notes.txt");
    writeFileSync(stray, "hello\n", "utf8");
    expect(runFailing("validate.js", [stray], projectDir).status).toBe(2);
  });
});

describe("workflow script guards", () => {
  function workflowDir(): string {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const slug = c.folderPath.split("/").pop()!;
    runScript("add-workflow.js", ["--campaign", slug, "--name", "ship"], projectDir);
    return join(boardRoot, c.folderPath, "workflows", "ship");
  }

  it("add-run.js refuses a directory that is not a workflow folder", () => {
    const notAWorkflow = join(boardRoot, "campaigns", "q3");
    mkdirSync(notAWorkflow, { recursive: true });
    const { status, stderr } = runFailing(
      "add-run.js",
      ["--workflow", notAWorkflow, "--status", "done", "--summary", "x"],
      projectDir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("workflow.js not found");
  });

  it("add-run.js refuses a non-directory and missing args", () => {
    expect(
      runFailing("add-run.js", ["--workflow", join(boardRoot, "nope"), "--status", "done", "--summary", "x"], projectDir)
        .stderr,
    ).toContain("not a directory");
    expect(runFailing("add-run.js", [], projectDir).status).toBe(2);
  });

  it("add-run.js defaults the date to today when --at is omitted", () => {
    const dir = workflowDir();
    runScript("add-run.js", ["--workflow", dir, "--status", "done", "--summary", "green"], projectDir);
    const line = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim()) as { at: string };
    expect(line.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // sync-meta.js rewrites source files in bulk (--all can touch every workflow under a board), so
  // its refusals matter as much as add-run.js's — a silent write on a file it could not fully read
  // is how a bad rewrite reaches disk.
  it("sync-meta.js refuses when invoked with no arguments", () => {
    const { status, stderr } = runFailing("sync-meta.js", [], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("usage: sync-meta.js");
  });

  it("sync-meta.js refuses a workflow directory that does not exist, and writes nothing", () => {
    const missing = join(boardRoot, "campaigns", "nope");
    const { status, stderr } = runFailing("sync-meta.js", [missing], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("no workflow.js at");
    expect(existsSync(missing)).toBe(false);
  });

  it("sync-meta.js refuses a workflow.js with no `export const meta` literal, leaving it untouched", () => {
    const dir = workflowDir();
    const jsPath = join(dir, "workflow.js");
    writeFileSync(jsPath, "// no meta here\nexport default 1;\n", "utf8");
    const before = readFileSync(jsPath, "utf8");

    const { status, stderr } = runFailing("sync-meta.js", [dir], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("no `export const meta` literal");
    expect(readFileSync(jsPath, "utf8")).toBe(before);
  });

  it("sync-meta.js refuses a meta that is not a pure object literal, leaving the file untouched", () => {
    const dir = workflowDir();
    const jsPath = join(dir, "workflow.js");
    writeFileSync(jsPath, "export const meta = { name: someVar }\nphase('Run')\n", "utf8");
    const before = readFileSync(jsPath, "utf8");

    const { status, stderr } = runFailing("sync-meta.js", [dir], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("refusing to rewrite the script");
    expect(readFileSync(jsPath, "utf8")).toBe(before);
  });

  it("sync-meta.js refuses a body that fails to parse, leaving the file untouched", () => {
    const dir = workflowDir();
    const jsPath = join(dir, "workflow.js");
    writeFileSync(jsPath, 'export const meta = { name: "ship", description: "", phases: [] }\nphase(\'Run\'\n', "utf8");
    const before = readFileSync(jsPath, "utf8");

    const { status, stderr } = runFailing("sync-meta.js", [dir], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("body does not parse");
    expect(readFileSync(jsPath, "utf8")).toBe(before);
  });

  it("sync-meta.js --all updates every workflow it finds under .octobots/campaigns", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const slug = c.folderPath.split("/").pop()!;
    runScript("add-workflow.js", ["--campaign", slug, "--name", "ship"], projectDir);
    runScript("add-workflow.js", ["--campaign", slug, "--name", "gate"], projectDir);
    const shipPath = join(boardRoot, c.folderPath, "workflows", "ship", "workflow.js");
    const gatePath = join(boardRoot, c.folderPath, "workflows", "gate", "workflow.js");
    // Drift both from what their (unchanged) bodies actually produce, so --all has real work to do.
    writeFileSync(shipPath, readFileSync(shipPath, "utf8").replace('title: "Run"', 'title: "Old"'), "utf8");
    writeFileSync(gatePath, readFileSync(gatePath, "utf8").replace('title: "Run"', 'title: "Old"'), "utf8");

    const out = runScript("sync-meta.js", ["--all"], projectDir);

    expect(out).toContain("2 of 2 workflow(s) updated");
    expect(readFileSync(shipPath, "utf8")).not.toContain('"Old"');
    expect(readFileSync(gatePath, "utf8")).not.toContain('"Old"');
    expect(readFileSync(shipPath, "utf8")).toContain('title: "Run"');
    expect(readFileSync(gatePath, "utf8")).toContain('title: "Run"');
  });
});
