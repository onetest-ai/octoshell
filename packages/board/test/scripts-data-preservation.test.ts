/**
 * Data-preservation tests for the octobots pack scripts.
 *
 * Every mutating script does readEntity → mutate → dumpEntity, overwriting the whole `<kind>.yaml`.
 * So any field `entity-io.mjs` does not model is silently destroyed by the next unrelated script
 * run. These tests pin the user-facing scenarios where that costs real content — a campaign's
 * decision record wiped by linking a document, a task's notes wiped by a status change — and the
 * validator's blindness to acceptance criteria that were appended as prose into `notes` instead of
 * `acceptance_criteria` ("stranded criteria").
 *
 * Fixtures are seeded THROUGH the parser (loadEntity/dumpEntity), never by appending text — the
 * same rule the scripts enforce for agents.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCampaign, createMission, createTask, createBug, migrateEntitiesToYaml } from "../src/write.js";
import { loadEntity, dumpEntity, type EntityFields, type EntityKind } from "../src/entity-schema.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);

/** The pack's standalone entity I/O, imported directly so its round-trip is unit-testable. */
const io = (await import(pathToFileURL(join(SCRIPTS, "entity-io.mjs")).href)) as {
  loadEntity: (text: string) => Record<string, unknown>;
  dumpEntity: (kind: string, fields: Record<string, unknown>) => string;
};

function runScript(name: string, args: string[], cwd: string): string {
  return execFileSync("node", [join(SCRIPTS, name), ...args], { cwd, encoding: "utf8" });
}

/** Run a script that is expected to fail; returns its exit status and stderr. */
function runFailing(name: string, args: string[], cwd: string): { status: number; stderr: string } {
  try {
    runScript(name, args, cwd);
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 0, stderr: e.stderr ?? "" };
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

/** Seed a field onto an existing `<kind>.yaml` through the parser (never by appending text). */
function seed(yamlPath: string, kind: EntityKind, patch: Partial<EntityFields>): void {
  const fields = loadEntity(readFileSync(yamlPath, "utf8"));
  writeFileSync(yamlPath, dumpEntity(kind, { ...fields, ...patch }), "utf8");
}

const DECISION_RECORD = [
  "## Decision 2026-07-20",
  "We ship the YAML board without a server. Rejected: sqlite cache (breaks multi-agent writes).",
  "",
  "## Sign-off",
  "Product approved scope on 2026-07-21.",
].join("\n");

let projectDir: string;
let boardRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "scripts-preserve-"));
  boardRoot = join(projectDir, ".octobots");
  mkdirSync(boardRoot);
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("entity-io round-trip preserves every field the app writes", () => {
  it("keeps notes for a campaign", () => {
    const yaml = io.dumpEntity("campaign", {
      name: "Q3 Rollout",
      description: "d",
      acceptanceCriteria: [{ text: "shipped", done: false }],
      documents: [],
      notes: DECISION_RECORD,
    });
    expect(io.loadEntity(yaml).notes).toBe(DECISION_RECORD);
  });

  it("keeps notes for a mission, task and bug", () => {
    for (const kind of ["mission", "task", "bug"]) {
      const yaml = io.dumpEntity(kind, {
        name: `${kind} name`,
        description: "d",
        acceptanceCriteria: [],
        documents: [],
        notes: "kept",
      });
      expect(io.loadEntity(yaml).notes, `${kind} lost its notes`).toBe("kept");
    }
  });

  it("omits notes entirely when blank, rather than writing an empty key", () => {
    const yaml = io.dumpEntity("task", {
      name: "T1.1 - x",
      description: "",
      acceptanceCriteria: [],
      documents: [],
      notes: "   ",
    });
    expect(yaml).not.toContain("notes:");
    expect(io.loadEntity(yaml).notes).toBeUndefined();
  });

  it("agrees byte-for-byte with the app's entity-schema dump", () => {
    const fields: EntityFields = {
      name: "M1 - Auth",
      description: "d",
      acceptanceCriteria: [{ text: "jwt validated", done: true }],
      documents: [{ label: "spec", target: "docs/spec.md" }],
      status: "executing",
      tokenomics: { effort_days: 2 },
      notes: DECISION_RECORD,
    };
    expect(io.dumpEntity("mission", fields as unknown as Record<string, unknown>)).toBe(
      dumpEntity("mission", fields),
    );
  });
});

describe("add-doc.js preserves the entity's other content", () => {
  it("keeps a campaign's decision record when a document is linked", () => {
    const c = createCampaign(boardRoot, { name: "Q3 Rollout" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
    seed(campaignYaml, "campaign", { notes: DECISION_RECORD });

    runScript("add-doc.js", [campaignYaml, "M1 spec", "docs/spec.md"], projectDir);

    const after = loadEntity(readFileSync(campaignYaml, "utf8"));
    expect(after.notes).toBe(DECISION_RECORD);
    expect(after.documents).toEqual([{ label: "M1 spec", target: "docs/spec.md" }]);
  });

  it("keeps a mission's notes, criteria and tokenomics when a document is linked", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [x] works" });
    const missionYaml = join(boardRoot, m.folderPath, "mission.yaml");
    seed(missionYaml, "mission", { notes: "why we chose JWT", tokenomics: { effort_days: 3 } });

    runScript("add-doc.js", [missionYaml, "RFC", "https://example.com/rfc"], projectDir);

    const after = loadEntity(readFileSync(missionYaml, "utf8"));
    expect(after.notes).toBe("why we chose JWT");
    expect(after.tokenomics).toEqual({ effort_days: 3 });
    expect(after.acceptanceCriteria).toEqual([{ text: "works", done: true }]);
  });

  it("leaves the file untouched when the target is already linked", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
    seed(campaignYaml, "campaign", { notes: DECISION_RECORD });
    runScript("add-doc.js", [campaignYaml, "spec", "docs/spec.md"], projectDir);
    const first = readFileSync(campaignYaml, "utf8");

    expect(runScript("add-doc.js", [campaignYaml, "renamed", "docs/spec.md"], projectDir)).toContain(
      "already present",
    );
    expect(readFileSync(campaignYaml, "utf8")).toBe(first);
  });

  it("refuses a task (documents attach to campaigns and missions only)", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    const { status, stderr } = runFailing(
      "add-doc.js",
      [join(boardRoot, t.folderPath, "task.yaml"), "spec", "docs/spec.md"],
      projectDir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("campaigns and missions only");
  });
});

describe("set-status.js preserves the entity's other content", () => {
  it("keeps a task's notes and role when its status changes", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", role: "dev", acceptanceCriteria: "- [ ] jwt" });
    const taskYaml = join(boardRoot, t.folderPath, "task.yaml");
    seed(taskYaml, "task", { notes: "blocked on the auth0 tenant until 2026-07-30" });

    runScript("set-status.js", [join(boardRoot, m.folderPath), "T1.1 - JWT", "done"], projectDir);

    const after = loadEntity(readFileSync(taskYaml, "utf8"));
    expect(after.notes).toBe("blocked on the auth0 tenant until 2026-07-30");
    expect(after.role).toBe("dev");
    expect(after.status).toBe("done");
    expect(after.acceptanceCriteria).toEqual([{ text: "jwt", done: false }]);
  });

  it("keeps a mission's notes and documents when its status changes", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const missionYaml = join(boardRoot, m.folderPath, "mission.yaml");
    seed(missionYaml, "mission", {
      notes: DECISION_RECORD,
      documents: [{ label: "spec", target: "docs/spec.md" }],
    });

    runScript("set-status.js", [join(boardRoot, c.folderPath), "M1 - Auth", "active"], projectDir);

    const after = loadEntity(readFileSync(missionYaml, "utf8"));
    expect(after.notes).toBe(DECISION_RECORD);
    expect(after.documents).toEqual([{ label: "spec", target: "docs/spec.md" }]);
  });

  it("keeps a bug's notes, severity and repro fields when its status changes", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const b = createBug(boardRoot, { campaignId: c.id },{ title: "B1 - Notes wiped", severity: "critical" });
    const bugYaml = join(boardRoot, b.folderPath, "bug.yaml");
    seed(bugYaml, "bug", {
      notes: "found while linking a doc",
      stepsToReproduce: "run add-doc.js on an entity with notes",
      expected: "notes preserved",
      actual: "notes gone",
    });

    runScript("set-status.js", [join(boardRoot, c.folderPath), "B1 - Notes wiped", "done"], projectDir);

    const after = loadEntity(readFileSync(bugYaml, "utf8"));
    expect(after.notes).toBe("found while linking a doc");
    expect(after.severity).toBe("critical");
    expect(after.actual).toBe("notes gone");
    expect(after.status).toBe("done");
  });
});

describe("set-criterion.js preserves the entity's other content", () => {
  it("keeps a task's notes when a criterion is checked", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] jwt validated" });
    const taskYaml = join(boardRoot, t.folderPath, "task.yaml");
    seed(taskYaml, "task", { notes: DECISION_RECORD });

    runScript("set-criterion.js", [join(boardRoot, t.folderPath), "check", "1"], projectDir);

    const after = loadEntity(readFileSync(taskYaml, "utf8"));
    expect(after.notes).toBe(DECISION_RECORD);
    expect(after.acceptanceCriteria).toEqual([{ text: "jwt validated", done: true }]);
  });

  it("keeps a task's notes when a criterion is appended", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT" });
    const taskYaml = join(boardRoot, t.folderPath, "task.yaml");
    seed(taskYaml, "task", { notes: DECISION_RECORD });

    runScript("set-criterion.js", [join(boardRoot, t.folderPath), "add", "expired tokens are rejected"], projectDir);

    const after = loadEntity(readFileSync(taskYaml, "utf8"));
    expect(after.notes).toBe(DECISION_RECORD);
    expect(after.acceptanceCriteria.map((x) => x.text)).toEqual(["expired tokens are rejected"]);
  });
});

describe("migrate.js preserves free-form prose from a legacy .md", () => {
  it("folds appended decisions below the managed block into notes", () => {
    const cDir = join(boardRoot, "campaigns", "q3");
    mkdirSync(cDir, { recursive: true });
    writeFileSync(
      join(cDir, "campaign.md"),
      [
        "# Q3 Rollout",
        "",
        "## Status",
        "executing",
        "",
        "## Description",
        "c",
        "",
        "<!-- Auto-generated by Octobots from the campaign's fields above. -->",
        "",
        "## Missions",
        "- [status:active] M1 - Auth",
        "",
        "## Decision 2026-07-20",
        "We ship the YAML board without a server.",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(runScript("migrate.js", [], projectDir)).toContain("migrated 1 entity file(s) to yaml");

    const after = loadEntity(readFileSync(join(cDir, "campaign.yaml"), "utf8"));
    expect(after.notes).toContain("## Decision 2026-07-20");
    expect(after.notes).toContain("We ship the YAML board without a server.");
    // The structural projection is folded into the children, never kept as prose.
    expect(after.notes).not.toContain("## Missions");
  });

  it("matches the app's own migration byte-for-byte on the same tree", () => {
    const write = (dir: string, body: string): void => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "campaign.md"), body, "utf8");
    };
    const body = [
      "# Q3 Rollout",
      "",
      "## Description",
      "c",
      "",
      "<!-- Auto-generated by Octobots from the campaign's fields above. -->",
      "",
      "## Rationale",
      "Files beat a database for multi-agent writes.",
      "",
    ].join("\n");

    write(join(boardRoot, "campaigns", "q3"), body);
    const appRoot = join(projectDir, "app-copy", ".octobots");
    write(join(appRoot, "campaigns", "q3"), body);

    runScript("migrate.js", [], projectDir);
    // The library performs the same sweep; both must land on identical yaml.
    migrateEntitiesToYaml(appRoot);

    expect(readFileSync(join(boardRoot, "campaigns", "q3", "campaign.yaml"), "utf8")).toBe(
      readFileSync(join(appRoot, "campaigns", "q3", "campaign.yaml"), "utf8"),
    );
  });
});

describe("editing a not-yet-migrated .md entity preserves its prose", () => {
  /** A legacy board: the scripts read `<kind>.md` and persist the edit as `<kind>.yaml`. */
  function legacyTask(): { taskDir: string; missionDir: string } {
    const missionDir = join(boardRoot, "campaigns", "q3", "missions", "m1-auth");
    const taskDir = join(missionDir, "tasks", "t1-1-jwt");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(missionDir, "mission.md"),
      ["# M1 - Auth", "", "## Description", "m", "", "## Acceptance Criteria", "- [ ] works", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(taskDir, "task.md"),
      [
        "# T1.1 - JWT",
        "",
        "## Description",
        "t",
        "",
        "## Acceptance Criteria",
        "- [ ] jwt validated",
        "",
        "<!-- Auto-generated by Octobots from the task's fields above. -->",
        "",
        "## Decision 2026-07-20",
        "RS256 only; HS256 is rejected outright.",
        "",
      ].join("\n"),
      "utf8",
    );
    return { taskDir, missionDir };
  }

  it("keeps appended decisions when set-status.js converts the .md to yaml", () => {
    const { taskDir, missionDir } = legacyTask();

    runScript("set-status.js", [missionDir, "T1.1 - JWT", "done"], projectDir);

    const after = loadEntity(readFileSync(join(taskDir, "task.yaml"), "utf8"));
    expect(after.notes).toContain("RS256 only; HS256 is rejected outright.");
    expect(after.status).toBe("done");
    expect(after.acceptanceCriteria).toEqual([{ text: "jwt validated", done: false }]);
  });

  it("keeps appended decisions when set-criterion.js converts the .md to yaml", () => {
    const { taskDir } = legacyTask();

    runScript("set-criterion.js", [taskDir, "check", "1"], projectDir);

    const after = loadEntity(readFileSync(join(taskDir, "task.yaml"), "utf8"));
    expect(after.notes).toContain("RS256 only; HS256 is rejected outright.");
    expect(after.acceptanceCriteria).toEqual([{ text: "jwt validated", done: true }]);
  });
});

describe("validate.js catches acceptance criteria stranded in notes", () => {
  /** A task whose criteria were appended as prose instead of written to acceptance_criteria. */
  function taskWithStrandedCriteria(criteria: string): string {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", acceptanceCriteria: criteria });
    const taskYaml = join(boardRoot, t.folderPath, "task.yaml");
    seed(taskYaml, "task", {
      notes: ["## Acceptance Criteria", "- [ ] expired tokens are rejected with 401", "- [x] tampered tokens are rejected"].join(
        "\n",
      ),
    });
    return taskYaml;
  }

  it("fails a task whose only criteria are checkbox lines inside notes", () => {
    const taskYaml = taskWithStrandedCriteria("");
    const { status, stderr } = runFailing("validate.js", [taskYaml], projectDir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/stranded/i);
    expect(stderr).toContain("set-criterion.js");
  });

  it("still fails when real criteria exist alongside the stranded ones", () => {
    const taskYaml = taskWithStrandedCriteria("- [ ] jwt validated");
    const { status, stderr } = runFailing("validate.js", [taskYaml], projectDir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/stranded/i);
  });

  it("reports how many criteria are stranded", () => {
    const taskYaml = taskWithStrandedCriteria("- [ ] jwt validated");
    const { stderr } = runFailing("validate.js", [taskYaml], projectDir);
    expect(stderr).toContain("2");
  });

  it("passes prose notes that carry no checkbox lines", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const t = createTask(boardRoot, m.id, { name: "T1.1 - JWT", acceptanceCriteria: "- [ ] jwt validated" });
    const taskYaml = join(boardRoot, t.folderPath, "task.yaml");
    seed(taskYaml, "task", { notes: DECISION_RECORD });

    expect(runScript("validate.js", [taskYaml], projectDir)).toContain("OK");
  });

  it("flags stranded criteria on a campaign and a mission too", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const campaignYaml = join(boardRoot, c.folderPath, "campaign.yaml");
    seed(campaignYaml, "campaign", { notes: "- [ ] every mission is merged" });
    expect(runFailing("validate.js", [campaignYaml], projectDir).stderr).toMatch(/stranded/i);

    const m = createMission(boardRoot, c.id, { title: "M1 - Auth", acceptanceCriteria: "- [ ] ships" });
    const missionYaml = join(boardRoot, m.folderPath, "mission.yaml");
    seed(missionYaml, "mission", { notes: "- [x] auth reviewed" });
    expect(runFailing("validate.js", [missionYaml], projectDir).stderr).toMatch(/stranded/i);
  });

  it("does not flag a bug's repro checklist (bugs carry no acceptance criteria)", () => {
    const c = createCampaign(boardRoot, { name: "Camp" });
    const b = createBug(boardRoot, { campaignId: c.id },{ title: "B1 - Broken" });
    const bugYaml = join(boardRoot, b.folderPath, "bug.yaml");
    seed(bugYaml, "bug", { notes: "- [x] reproduced on main\n- [ ] reproduced on the release branch" });

    expect(runScript("validate.js", [bugYaml], projectDir)).toContain("OK");
  });
});
