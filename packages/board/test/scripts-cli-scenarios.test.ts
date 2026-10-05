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

  it("ignores a legacy workflows/ folder: it is the user's data, not something validate reads", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const dir = join(boardRoot, c.folderPath, "workflows", "ship");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.js"), "this is not even javascript {{{\n", "utf8");
    const out = runScript("validate.js", [join(boardRoot, c.folderPath)], projectDir);
    expect(out).toContain("OK");
    // ...but it says so, once, relative to .octobots/, and never touches the folder.
    expect(out).toContain(`warning: ${c.folderPath}/workflows`);
    expect(out).toContain("no longer read since pack v57");
    expect(readFileSync(join(dir, "workflow.js"), "utf8")).toBe("this is not even javascript {{{\n");
  });

  describe("leftover workflows/ folders (the real-data shape: several at mission level, one with runs)", () => {
    const warningLines = (out: string) => out.split("\n").filter((l) => l.startsWith("warning:"));

    function seedMissions(): { campaign: string; missions: string[]; ids: string[] } {
      const c = createCampaign(boardRoot, { name: "Octograph" });
      const missions: string[] = [];
      const ids: string[] = [];
      for (const n of ["M3", "M4", "M5", "M6", "M7"]) {
        const m = createMission(boardRoot, c.id, { title: `${n} - Part ${n}`, acceptanceCriteria: "- [ ] it works" });
        missions.push(m.folderPath);
        ids.push(m.id);
        const wf = join(boardRoot, m.folderPath, "workflows", "run");
        mkdirSync(wf, { recursive: true });
        writeFileSync(join(wf, "workflow.js"), "export const meta = {}\n", "utf8");
        if (n === "M5") writeFileSync(join(wf, "runs.jsonl"), '{"run":1}\n', "utf8");
      }
      return { campaign: c.folderPath, missions, ids };
    }

    it("a campaign folder gets one warning per workflows/ folder under it, exit 0, files untouched", () => {
      const { campaign, missions } = seedMissions();
      const out = runScript("validate.js", [join(boardRoot, campaign)], projectDir);
      const lines = warningLines(out);
      expect(lines).toHaveLength(5);
      for (const m of missions) {
        expect(lines.filter((l) => l.includes(`${m}/workflows`) && l.includes("no longer read since pack v57"))).toHaveLength(1);
      }
      expect(out).toContain("OK");
      expect(existsSync(join(boardRoot, missions[2]!, "workflows", "run", "runs.jsonl"))).toBe(true);
    });

    it("also finds a campaign-level workflows/ alongside the mission-level ones", () => {
      const { campaign } = seedMissions();
      mkdirSync(join(boardRoot, campaign, "workflows", "x"), { recursive: true });
      expect(warningLines(runScript("validate.js", [join(boardRoot, campaign)], projectDir))).toHaveLength(6);
    });

    it("a mission or a task validates only what is under it", () => {
      const { missions, ids } = seedMissions();
      const mission = join(boardRoot, missions[0]!);
      expect(warningLines(runScript("validate.js", [mission], projectDir))).toHaveLength(1);
      const t = createTask(boardRoot, ids[0]!, { name: "T3.1 - Do a thing", acceptanceCriteria: "- [ ] it works" });
      expect(warningLines(runScript("validate.js", [join(boardRoot, t.folderPath)], projectDir))).toHaveLength(0);
    });

    it("an invalid entity still exits 1 and still lists the warnings", () => {
      const { campaign } = seedMissions();
      seed(join(boardRoot, campaign, "campaign.yaml"), "campaign", { name: "" });
      const { status, stderr } = runFailing("validate.js", [join(boardRoot, campaign)], projectDir);
      expect(status).toBe(1);
      expect(stderr).toContain("missing a `name`");
    });

    it("a board without workflows/ folders prints no warning", () => {
      const c = createCampaign(boardRoot, { name: "Clean" });
      expect(warningLines(runScript("validate.js", [join(boardRoot, c.folderPath)], projectDir))).toHaveLength(0);
    });

    it("validate.js on a workflow.js exits 2 'not an entity file'", () => {
      const { missions } = seedMissions();
      const wf = join(boardRoot, missions[0]!, "workflows", "run", "workflow.js");
      const { status, stderr } = runFailing("validate.js", [wf], projectDir);
      expect(status).toBe(2);
      expect(stderr).toContain("not an entity file");
    });
  });

  it("exits 2 for a folder holding no entity", () => {
    const empty = join(boardRoot, "campaigns", "empty");
    mkdirSync(empty, { recursive: true });
    const { status, stderr } = runFailing("validate.js", [empty], projectDir);
    expect(status).toBe(2);
    expect(stderr).toContain("no entity");
  });

  it("exits 2 for a file that is not an entity", () => {
    const stray = join(boardRoot, "notes.txt");
    writeFileSync(stray, "hello\n", "utf8");
    expect(runFailing("validate.js", [stray], projectDir).status).toBe(2);
  });
});

describe("pack doctor.js", () => {
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
    const SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer"];
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

    it("leftover workflows/ folders produce one board warn with the count and a fix that never says delete; never fail", () => {
      installSkills();
      installPrimer(57);
      mkdirSync(join(projectDir, ".octobots", "tokenomics"), { recursive: true });
      const c = createCampaign(boardRoot, { name: "Octograph" });
      for (const n of ["M3", "M4", "M5", "M6", "M7"]) {
        const m = createMission(boardRoot, c.id, { title: `${n} - Part ${n}`, acceptanceCriteria: "- [ ] it works" });
        const wf = join(boardRoot, m.folderPath, "workflows", "run");
        mkdirSync(wf, { recursive: true });
        writeFileSync(join(wf, "workflow.js"), "x\n", "utf8");
        if (n === "M4") writeFileSync(join(wf, "runs.jsonl"), "{}\n", "utf8");
      }
      mkdirSync(join(boardRoot, c.folderPath, "workflows"), { recursive: true });
      const board = findings(projectDir).filter((x) => x.area === "board");
      const warns = board.filter((x) => x.level === "warn") as { level: string; msg: string; fix?: string }[];
      expect(warns).toHaveLength(1);
      expect(warns[0]!.msg).toContain("6");
      expect(warns[0]!.msg).toContain("no longer read since pack v57");
      expect(warns[0]!.msg).toContain(`${c.folderPath}/workflows`);
      expect(warns[0]!.fix).toMatch(/leave|move/i);
      expect(warns[0]!.fix).not.toMatch(/delet|remove|rm /i);
      expect(board.some((x) => x.level === "fail")).toBe(false);
      expect(board.some((x) => x.level === "ok" && x.msg.includes("1 campaign(s)"))).toBe(true);
      expect(existsSync(join(boardRoot, c.folderPath, "workflows"))).toBe(true);
      // The leftover folders alone never turn the run into a failure.
      expect(JSON.parse(run(projectDir).out).findings.filter((x: { level: string }) => x.level === "fail").map((x: { area: string }) => x.area)).not.toContain("board");
    });

    it("no workflows/ folders: no board warn", () => {
      createCampaign(boardRoot, { name: "Clean" });
      expect(findings(projectDir).filter((x) => x.area === "board" && x.level === "warn")).toHaveLength(0);
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
});
