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
import { createCampaign, createMission, createTask, createBug, createWorkflow } from "../src/write.js";
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

  // A phase's `detail` is AUTHORED, not derived — nothing in the body carries it, and it is the one
  // meta.phases field Claude Code's own Workflow runtime consumes. Extraction never emits it, so
  // before `mergeAuthoredPhases` a detail-bearing workflow reported "meta is out of date" on every
  // validate and sync-meta.js "fixed" that by DELETING the caption. Data loss, silently, on the one
  // field the runtime reads.
  it("sync-meta.js regenerates the graph without losing an authored phase detail", () => {
    const dir = workflowDir();
    const jsPath = join(dir, "workflow.js");
    writeFileSync(
      jsPath,
      [
        "export const meta = {",
        '  name: "ship",',
        '  description: "",',
        "  phases: [",
        '    { title: "Run", detail: "build every task, then gate", steps: [] },',
        "  ],",
        "}",
        "",
        "phase('Run')",
        "await agent(p, { phase: 'Run', label: 'build', agentType: 'js-dev' })",
        "",
      ].join("\n"),
      "utf8",
    );

    const out = runScript("sync-meta.js", [dir], projectDir);
    expect(out).toContain("1 of 1 workflow(s) updated");

    const updated = readFileSync(jsPath, "utf8");
    // The graph was regenerated from the body…
    expect(updated).toContain('"id":"run-1"');
    expect(updated).toContain('"agent":"js-dev"');
    // …and the caption survived it.
    expect(updated).toContain('detail: "build every task, then gate"');

    // Idempotent: the file it just wrote is the file it would write again.
    expect(runScript("sync-meta.js", [dir], projectDir)).toContain("unchanged");
    // And a detail-bearing workflow validates clean, rather than reporting "meta is out of date"
    // forever because the extractor cannot produce a field no body carries.
    expect(runScript("validate.js", [dir], projectDir)).toContain("OK");
  });

  // The pack's validate.js mirrors packages/board's validateWorkflow, so the two corrected messages
  // are asserted on this side too — a mirror that drifts on wording is a mirror that drifts.
  it("validate.js names an unreadable { phase } as such, not as a missing label", () => {
    const dir = workflowDir();
    writeFileSync(
      join(dir, "workflow.js"),
      [
        'export const meta = { name: "ship", description: "", phases: [{ title: "Build", steps: [] }] }',
        "const ph = 'Build'",
        "await agent(p, { phase: ph, label: 'unresolvable', agentType: 'js-dev' })",
        "",
      ].join("\n"),
      "utf8",
    );
    const { stderr } = runFailing("validate.js", [dir], projectDir);
    expect(stderr).toContain("not a string literal");
    expect(stderr).not.toContain("no readable label");
  });

  it("validate.js tells a malformed pointer file apart from one missing its `uses` key", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const missionDir = join(boardRoot, m.folderPath);
    mkdirSync(join(missionDir, "workflows", "implementation"), { recursive: true });
    writeFileSync(
      join(missionDir, "workflows", "implementation", "workflow.json"),
      '{ "uses": "../../../../workflows/implementation" ',
      "utf8",
    );

    const { stderr } = runFailing("validate.js", [missionDir], projectDir);
    expect(stderr).toContain("not valid JSON");
    expect(stderr).not.toContain("no `uses` string");
  });

  // The two scaffolds — the pack's add-workflow.js and packages/board's createWorkflow, which the
  // VS Code "new workflow" command calls — are the same command from an author's point of view, so
  // they must hand out the same file. The retired "keep meta.phases in step with the body" doctrine
  // survived in the TS one for a whole branch because nothing compared them.
  it("add-workflow.js scaffolds byte-for-byte what the app's createWorkflow scaffolds", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const slug = c.folderPath.split("/").pop()!;
    runScript("add-workflow.js", ["--campaign", slug, "--name", "ship"], projectDir);
    const fromScript = readFileSync(join(boardRoot, c.folderPath, "workflows", "ship", "workflow.js"), "utf8");

    const { folderPath } = createWorkflow(boardRoot, { campaignId: c.id }, { name: "ship" });
    const fromApp = readFileSync(join(boardRoot, folderPath, "workflow.js"), "utf8");

    // The slug differs (the app de-duplicates against the sibling the script just made), so compare
    // everything else — including the comment block, which is the half that drifted.
    expect(fromApp.replace(/"ship-2"/g, '"ship"')).toBe(fromScript);
    expect(fromApp).toContain("sync-meta.js");
    expect(fromApp).not.toContain("Keep `meta.phases`");
  });

  // doctor.js config-dir check (M1 AC8). Claude Code writes transcripts to
  // $CLAUDE_CONFIG_DIR/projects/<slug> (default ~/.claude/projects/<slug>) and the tokenomics
  // collector reads exactly that, so the default is healthy and a per-repo config dir is not advice.
  describe("doctor.js config-dir", () => {
    // The slug rule is restated here on purpose: the check must agree with the rule, not with doctor.js.
    const slugOf = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

    function doctor(root: string, env: Record<string, string | undefined>): { findings: { level: string; area: string; msg: string; fix?: string }[] } {
      // HOME is a temp dir so the real ~/.claude is never consulted; CLAUDE_CONFIG_DIR is removed
      // unless the case sets it.
      const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
      delete childEnv.CLAUDE_CONFIG_DIR;
      if (env.CLAUDE_CONFIG_DIR !== undefined) childEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
      try {
        let out: string;
        try {
          out = execFileSync("node", [join(SCRIPTS, "doctor.js"), "--root", root, "--json"], { encoding: "utf8", env: childEnv });
        } catch (err: unknown) {
          out = (err as { stdout?: string }).stdout ?? "";
        }
        return JSON.parse(out);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
    const configDir = (r: ReturnType<typeof doctor>) => r.findings.find((f) => f.area === "config-dir")!;

    it("config-dir unset is ok and names ~/.claude/projects/<slug>, with no per-repo CLAUDE_CONFIG_DIR advice", () => {
      const f = configDir(doctor(projectDir, {}));
      expect(f.level).toBe("ok");
      expect(f.msg).toContain(`~/.claude/projects/${slugOf(projectDir)}`);
      expect(`${f.msg} ${f.fix ?? ""}`).not.toMatch(/export CLAUDE_CONFIG_DIR/);
      expect(`${f.msg} ${f.fix ?? ""}`).not.toContain(`${projectDir}/.claude`);
    });

    it("config-dir set names $CLAUDE_CONFIG_DIR/projects/<slug> as the root, wherever it points", () => {
      const cfg = join(tmpdir(), "somewhere-else", ".claude-alt");
      const f = configDir(doctor(projectDir, { CLAUDE_CONFIG_DIR: cfg }));
      expect(f.level).toBe("ok");
      expect(f.msg).toContain(`${cfg}/projects/${slugOf(projectDir)}`);
    });

    it("config-dir set to a project-local dir is still ok and names its projects/<slug>", () => {
      const cfg = join(projectDir, ".claude");
      const f = configDir(doctor(projectDir, { CLAUDE_CONFIG_DIR: cfg }));
      expect(f.level).toBe("ok");
      expect(f.msg).toContain(`${cfg}/projects/${slugOf(projectDir)}`);
    });

    it("config-dir from a worktree names the main checkout's slug", () => {
      const wt = join(projectDir, ".claude", "worktrees", "qa-m1");
      mkdirSync(wt, { recursive: true });
      const f = configDir(doctor(wt, {}));
      expect(f.msg).toContain(`~/.claude/projects/${slugOf(projectDir)}`);
      expect(f.msg).not.toContain(slugOf(wt));
    });
  });

  // The rest of doctor.js: pack payload, hooks, status line, tokenomics, board. Kept next to the
  // config-dir cases because the script is one process and `pnpm coverage:pack` measures it as one.
  describe("doctor.js pack, hooks and board checks", () => {
    function run(root: string, args: string[] = ["--json"]): { status: number; out: string } {
      const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.CLAUDE_CONFIG_DIR;
      try {
        return { status: 0, out: execFileSync("node", [join(SCRIPTS, "doctor.js"), "--root", root, ...args], { encoding: "utf8", env }) };
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string };
        return { status: e.status ?? -1, out: e.stdout ?? "" };
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
    const findings = (root: string) =>
      (JSON.parse(run(root).out) as { findings: { level: string; area: string; msg: string }[] }).findings;
    const SKILLS = ["mission-planner", "workflow-designer", "mission-execution", "mission-completion-gate", "knowledge-explorer"];
    function installSkills(versions: Record<string, number> = {}): void {
      for (const sk of SKILLS) {
        const dir = join(projectDir, ".claude", "skills", sk);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${sk}\nversion: ${versions[sk] ?? 57}\n---\n`);
      }
    }
    function installPrimer(v: number): void {
      mkdirSync(join(projectDir, ".octobots", "hooks"), { recursive: true });
      writeFileSync(join(projectDir, ".octobots", "hooks", "primer.mjs"), `// octobots-pack-version: ${v}\n`);
    }
    const settings = (obj: unknown) => {
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(join(projectDir, ".claude", "settings.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
    };

    it("an empty workspace fails on the missing pack and tokenomics, and exits 1 with readable text output", () => {
      const r = run(projectDir, []);
      expect(r.status).toBe(1);
      expect(r.out).toContain("skill missing: mission-planner");
      expect(r.out).toContain("failing");
      const f = findings(projectDir);
      expect(f.some((x) => x.area === "tokenomics" && x.level === "fail")).toBe(true);
      expect(f.some((x) => x.area === "hooks" && x.level === "note")).toBe(true);
      expect(f.some((x) => x.area === "statusline" && x.level === "note")).toBe(true);
      expect(f.some((x) => x.area === "board" && x.level === "note")).toBe(true);
    });

    it("a consistent install reports ok for the pack, primer, hooks, tokenomics and board", () => {
      installSkills();
      installPrimer(57);
      mkdirSync(join(projectDir, ".octobots", "tokenomics"), { recursive: true });
      mkdirSync(join(projectDir, ".octobots", "campaigns", "c1"), { recursive: true });
      mkdirSync(join(projectDir, ".octobots", "tools", "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(projectDir, ".octobots", "tools", "node_modules", ".bin", "ccusage"), "");
      settings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: ".octobots/hooks/primer.mjs" }] }], Other: "nope" } });
      const f = findings(projectDir);
      expect(f.find((x) => x.area === "pack" && /skills installed at v57/.test(x.msg))?.level).toBe("ok");
      expect(f.find((x) => x.area === "pack" && /primer.mjs v57/.test(x.msg))?.level).toBe("ok");
      expect(f.find((x) => x.area === "hooks")?.level).toBe("ok");
      expect(f.filter((x) => x.area === "tokenomics").every((x) => x.level === "ok")).toBe(true);
      expect(f.find((x) => x.area === "board")?.msg).toContain("1 campaign(s)");
    });

    it("skills that disagree on version, or a primer behind the skills, fail", () => {
      installSkills({ "mission-execution": 56 });
      installPrimer(55);
      const f = findings(projectDir);
      expect(f.find((x) => x.area === "pack" && /disagree/.test(x.msg))?.level).toBe("fail");
      expect(f.find((x) => x.area === "pack" && /primer.mjs is v55/.test(x.msg))?.level).toBe("fail");
    });

    it("an unparseable settings.json fails", () => {
      settings("{ not json");
      expect(findings(projectDir).find((x) => x.area === "settings")?.level).toBe("fail");
    });

    it("status line: a foreign one is left alone, ours without its script fails, ours with it is checked", () => {
      installSkills();
      settings({ statusLine: { type: "command", command: "echo hi" } });
      expect(findings(projectDir).find((x) => x.area === "statusline")?.msg).toContain("non-Octobots");

      settings({ statusLine: { type: "command", command: "bash ${CLAUDE_PROJECT_DIR}/.octobots/statusline.sh" } });
      expect(findings(projectDir).find((x) => x.area === "statusline")?.level).toBe("fail");

      mkdirSync(join(projectDir, ".octobots"), { recursive: true });
      writeFileSync(join(projectDir, ".octobots", "statusline.sh"), "# octobots-pack-version: 50\n");
      const sl = findings(projectDir).filter((x) => x.area === "statusline");
      expect(sl.some((x) => x.level === "warn" && /statusline.sh is v50/.test(x.msg))).toBe(true);

      writeFileSync(join(projectDir, ".octobots", "statusline.sh"), "# octobots-pack-version: 57\n");
      expect(findings(projectDir).find((x) => x.area === "statusline")?.level).toBe("ok");
    });
  });

  // mission-input.js hands a pipeline everything about one mission as JSON.
  describe("mission-input.js", () => {
    function seedBoard(): void {
      const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
      const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] login works\n- [ ] logout works" });
      createTask(boardRoot, m.id, { name: "T1.10 - Late", acceptanceCriteria: "- [ ] late" });
      createTask(boardRoot, m.id, { name: "T1.2 - Early", acceptanceCriteria: "- [ ] early" });
      createTask(boardRoot, m.id, { name: "T1.3 - QA verification", acceptanceCriteria: "- [ ] verified" });
    }

    it("emits the mission, its criteria, tasks in numeric order and the QA task", () => {
      seedBoard();
      const out = JSON.parse(runScript("mission-input.js", ["m1"], projectDir));
      expect(out.mission).toBe("M1");
      expect(out.criteria).toEqual(["login works", "logout works"]);
      expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(["T1.2", "T1.3", "T1.10"]);
      expect(out.qaTask.id).toBe("T1.3");
      expect(runScript("mission-input.js", ["M1", "--pretty"], projectDir)).toContain("\n  ");
    });

    it("refuses a malformed id, an unknown mission, and an ambiguous one", () => {
      seedBoard();
      expect(runFailing("mission-input.js", ["nope"], projectDir).status).toBe(2);
      expect(runFailing("mission-input.js", ["M9"], projectDir).stderr).toContain("not on the board");
      expect(runFailing("mission-input.js", ["M1", "--campaign", "other"], projectDir).stderr).toContain('under campaign "other"');
      const c2 = createCampaign(boardRoot, { name: "Q4 Rollout" });
      createMission(boardRoot, c2.id, { title: "M1 - Billing" });
      expect(runFailing("mission-input.js", ["M1"], projectDir).stderr).toContain("ambiguous");
      const slug = (n: string) => n.toLowerCase().replace(/\s+/g, "-");
      const picked = JSON.parse(runScript("mission-input.js", ["M1", "--campaign", slug("Q4 Rollout")], projectDir));
      expect(picked.missionName).toContain("Billing");
    });
  });
});
