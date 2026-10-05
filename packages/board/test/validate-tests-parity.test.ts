/**
 * The tests-pairing rule (a mission's tests README exists and is linked, every acceptance criterion is
 * covered by a TC, the README AC map agrees with the TC frontmatter, each TC file follows the TC format
 * contract) is spelled once per runtime: tc-io.mjs behind the pack's validate.js, tc-io.ts behind the board
 * library's validateBoard. This test pins the two to each other.
 *
 * Real boards (what a CI checkout has, plus OCTOBOTS_BOARD_COPIES) are compared AS SETS: they already
 * carry real gaps whose number changes with the board, so nothing here asserts a count about them.
 * Everything fixture-specific (an exact message, a planted gap) is asserted on synthetic temp boards.
 *
 * The rule is a WARNING only: it never changes validate.js's exit code and is never an error.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { validateBoard, type BoardFinding } from "../src/validate.js";
import { campaignDirs, trackedBoardCopies } from "./fixtures/real-board.js";
import { readmeText, scratch, synthBoard, tcText, writeTests } from "./fixtures/tests-board.js";

const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");
const VALIDATE_JS = join(SCRIPTS, "validate.js");

interface Run { status: number | null; stdout: string; stderr: string }
const validateJs = (arg: string, cwd?: string): Run => {
  const r = spawnSync("node", [VALIDATE_JS, arg], { encoding: "utf8", cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A tests-pairing finding: every message names a `tests/m<n>` path. */
const isTestsMessage = (m: string): boolean => /\/tests\/m\d+[a-z]*(\/|:)/.test(m);
const isEntityCampaign = (dir: string): boolean => existsSync(join(dir, "campaign.yaml")) || existsSync(join(dir, "campaign.md"));

/** The tests-pairing `warning:` lines validate.js prints for one directory. */
function packTestsWarnings(dir: string): string[] {
  return validateJs(dir).stdout.split("\n").filter((l) => l.startsWith("warning: ") && isTestsMessage(l));
}

/** validateBoard's tests-pairing findings, as the `warning: <message>` lines validate.js prints. */
function boardTestsWarnings(root: string): string[] {
  return validateBoard(root).filter((f) => isTestsMessage(f.message)).map((f) => `warning: ${f.message}`);
}

const packAll = (board: string): string[] => campaignDirs(board).filter(isEntityCampaign).flatMap(packTestsWarnings).sort();

describe("tests pairing: validate.js and validateBoard agree", () => {
  it("over every real board copy, as sets, and the rule never touches validate.js's exit code", () => {
    for (const board of trackedBoardCopies()) {
      const campaigns = campaignDirs(board).filter(isEntityCampaign);
      const before = campaigns.map((c) => validateJs(c).status);
      const baseline = boardTestsWarnings(board).sort();
      expect(packAll(board)).toEqual(baseline);
      expect(validateBoard(board).filter((f) => isTestsMessage(f.message)).every((f) => f.severity === "warning")).toBe(true);

      // Plant every kind of pairing problem on the first mission with a criterion; the sets must still agree.
      const planted = plantPairingProblems(board);
      expect(planted.length).toBeGreaterThan(0);
      const after = boardTestsWarnings(board).sort();
      expect(after.length).toBeGreaterThan(baseline.length);
      for (const message of planted) expect(after).toContain(`warning: ${message}`);
      expect(packAll(board)).toEqual(after);
      expect(validateBoard(board).filter((f) => isTestsMessage(f.message)).every((f) => f.severity === "warning")).toBe(true);

      // Warnings only: the pack's exit code is what the entities alone produce.
      expect(campaigns.map((c) => validateJs(c).status)).toEqual(before);
    }
  });

  it("adds no error to validateBoard", () => {
    for (const board of trackedBoardCopies()) {
      const errors = (): string[] => validateBoard(board).filter((f) => f.severity === "error").map((f) => `${f.mdPath}: ${f.message}`).sort();
      const before = errors();
      plantPairingProblems(board);
      expect(errors()).toEqual(before);
    }
  });
});

/**
 * Break the tests folder of the first mission that has an acceptance criterion: an unmapped extra TC with
 * a bad id, mission, covers, kind, status and no sections, plus README rows naming a missing TC, another
 * mission's AC and an uncovered mapping. Returns the board-relative messages that must now be reported.
 */
function plantPairingProblems(board: string): string[] {
  for (const campaignDir of campaignDirs(board).filter(isEntityCampaign)) {
    const missions = join(campaignDir, "missions");
    if (!existsSync(missions)) continue;
    for (const slug of readdirSync(missions)) {
      const file = join(missions, slug, "mission.yaml");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const name = /^name:\s*['"]?(M\d+[a-z]*)\b/im.exec(text)?.[1];
      if (!name || /^status:\s*cancel/im.test(text) || !/^acceptance_criteria:/m.test(text)) continue;
      const id = `M${name.slice(1).toLowerCase()}`;
      const folder = id.toLowerCase();
      const dir = join(campaignDir, "tests", folder);
      const rel = relative(board, dir).split(sep).join("/");
      mkdirSync(dir, { recursive: true });
      const readme = join(dir, "README.md");
      if (!existsSync(readme)) writeFileSync(readme, readmeText([]));
      appendFileSync(readme, `\n| ${id}-AC1 | planted | TC-998 |\n| M99-AC1 | planted | TC-999 |\n`);
      writeFileSync(join(dir, "TC-999_planted.md"), "---\nid: TC-001\nmission: M99\ncovers: [M99-AC1]\nkind: e2e\nstatus: nope\n---\nno sections\n");
      return [
        `${rel}/README.md: map row ${id}-AC1 names TC-998, which has no file in ${rel}`,
        `${rel}/README.md: map row M99-AC1 is not an acceptance criterion of ${id}`,
        `${rel}/TC-999_planted.md: id TC-001 does not match the filename prefix TC-999`,
        `${rel}/TC-999_planted.md: mission M99 does not match the folder ${folder} (expected ${id})`,
        `${rel}/TC-999_planted.md: covers names M99-AC1, which is not an acceptance criterion of ${id}`,
        `${rel}/TC-999_planted.md: kind "e2e" is not one of api, ui, cli, unit`,
        `${rel}/TC-999_planted.md: status "nope" is not one of draft, ready, pass, fail, blocked, unknown`,
        `${rel}/TC-999_planted.md: missing the "## Steps" section`,
        `${rel}/TC-999_planted.md: missing the "## Expected Final State" section`,
      ];
    }
  }
  return [];
}

describe("tests pairing on a synthetic board", () => {
  /** M1 (3 ACs): linked README, TC-001 covers AC1, TC-002 (legacy requirements) covers AC2; AC3 uncovered. M2: no folder. M3: cancelled. */
  function board() {
    const c = synthBoard(scratch("pairing-"), [
      { title: "M1 - Auth", acs: 3 },
      { title: "M2 - Billing", acs: 2 },
      { title: "M3 - Retired", acs: 2, status: "cancelled" },
    ]);
    writeTests(c, "m1", {
      "README.md": readmeText([["M1-AC1", "TC-001"], ["M1-AC2", "TC-002"], ["M1-AC3", "TC-003"]]),
      "TC-001_login.md": tcText(["id: TC-001", "title: login", "mission: M1", "covers: [M1-AC1]", "kind: api", "status: pass"]),
      "TC-002_logout.md": tcText(["id: TC-002", "title: logout", "priority: high", "type: functional", "requirements: [M1-AC2]"]),
    });
    return c;
  }
  const rel = (c: ReturnType<typeof board>, p: string) => `campaigns/${c.campaign}/tests/${p}`;

  it("reports exactly the planted gaps, as warnings, with the same text from both runtimes", () => {
    const c = board();
    const expected = [
      `warning: ${rel(c, "m1")}: M1-AC3 is not covered by any test case`,
      `warning: ${rel(c, "m1")}/README.md: map row M1-AC3 names TC-003, which has no file in ${rel(c, "m1")}`,
      `warning: ${rel(c, "m2")}/README.md: missing — M2 has no tests README; run add-tests.js to scaffold it`,
    ];
    expect(boardTestsWarnings(c.board).sort()).toEqual([...expected].sort());
    expect(packAll(c.board)).toEqual([...expected].sort());
    for (const f of validateBoard(c.board)) expect(f.severity).toBe("warning");
    const sev = validateBoard(c.board).filter((f) => isTestsMessage(f.message));
    expect(sev.map((f) => f.kind)).toEqual(["mission", "mission", "mission"]);
  });

  it("reports an unlinked README, a disagreeing map row and every kind of TC problem", () => {
    const c = synthBoard(scratch("pairing-"), [{ title: "M4 - Sync", acs: 2, linked: false }]);
    writeTests(c, "m4", {
      "README.md": readmeText([["M4-AC1", "TC-001, TC-002"], ["M5-AC1", "TC-001"]]),
      "TC-001_a.md": tcText(["id: TC-001", "mission: M4", "covers: [M4-AC1, M4-AC2]"]),
      "TC-002_b.md": tcText(["id: TC-003", "mission: m4", "covers: [M5-AC1]", "kind: e2e", "status: ok"], "no sections\n"),
      "TC-003_c.md": "---\ntitle: a: b\n---\n## Steps\n## Expected Final State\n",
    });
    const r = rel(c, "m4");
    const expected = [
      `${r}/README.md: not linked from the M4 documents (expected target .octobots/campaigns/${c.campaign}/tests/m4/README.md); run add-tests.js to link it`,
      `${r}/README.md: map row M4-AC1 lists TC-002, which does not list M4-AC1 in covers`,
      `${r}/README.md: map row M5-AC1 is not an acceptance criterion of M4`,
      `${r}/TC-002_b.md: id TC-003 does not match the filename prefix TC-002`,
      `${r}/TC-002_b.md: mission "m4" does not match M<n>`,
      `${r}/TC-002_b.md: covers names M5-AC1, which is not an acceptance criterion of M4`,
      `${r}/TC-002_b.md: kind "e2e" is not one of api, ui, cli, unit`,
      `${r}/TC-002_b.md: status "ok" is not one of draft, ready, pass, fail, blocked, unknown`,
      `${r}/TC-002_b.md: missing the "## Steps" section`,
      `${r}/TC-002_b.md: missing the "## Expected Final State" section`,
      `${r}/TC-003_c.md: frontmatter is missing or unparseable`,
    ].map((m) => `warning: ${m}`);
    expect(boardTestsWarnings(c.board).sort()).toEqual([...expected].sort());
    expect(packAll(c.board)).toEqual([...expected].sort());
    expect(validateBoard(c.board).every((f) => f.severity === "warning")).toBe(true);
  });

  it("is silent for a fully paired mission and for a cancelled one", () => {
    const c = synthBoard(scratch("pairing-"), [{ title: "M1 - Ok", acs: 1 }, { title: "M2 - Gone", acs: 4, status: "cancelled" }]);
    writeTests(c, "m1", { "README.md": readmeText([["M1-AC1", "TC-001"]]), "TC-001_a.md": tcText(["id: TC-001", "covers: [M1-AC1]"]) });
    expect(boardTestsWarnings(c.board)).toEqual([]);
    expect(packAll(c.board)).toEqual([]);
    expect(validateBoard(c.board)).toEqual([]);
  });

  it("applies in every status except cancelled", () => {
    for (const status of ["draft", "executing", "awaitingApproval", "done", "failed"]) {
      const c = synthBoard(scratch("pairing-"), [{ title: "M1 - x", acs: 1, status }]);
      expect(boardTestsWarnings(c.board)).toHaveLength(1);
      expect(packAll(c.board)).toEqual(boardTestsWarnings(c.board));
    }
  });

  it("ignores a legacy mission.md, which has no structured criteria or documents", () => {
    const board0 = scratch("pairing-");
    const dir = join(board0, "campaigns", "camp", "missions", "m1-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(board0, "campaigns", "camp", "campaign.md"), "# Camp\n");
    writeFileSync(join(dir, "mission.md"), "# M1 - x\n\n## Acceptance Criteria\n- [ ] a\n");
    expect(boardTestsWarnings(board0)).toEqual([]);
    expect(packAll(board0)).toEqual([]);
  });

  it("works on a board not named .octobots (paths stay relative to the board)", () => {
    const c = board();
    const other = join(c.board, "..", "my-board");
    spawnSync("cp", ["-R", c.board, other]);
    expect(boardTestsWarnings(other).sort()).toEqual(boardTestsWarnings(c.board).sort());
    expect(packAll(other)).toEqual(boardTestsWarnings(other).sort());
    expect(boardTestsWarnings(other).every((l) => l.startsWith("warning: campaigns/"))).toBe(true);
  });

  it("validate.js on a mission folder reports that mission's pairing warnings only", () => {
    const c = board();
    const m1 = validateJs(c.missionDirs.m1!);
    const lines = m1.stdout.split("\n").filter((l) => l.startsWith("warning: "));
    expect(lines.every((l) => l.includes("/tests/m1"))).toBe(true);
    expect(lines).toHaveLength(2);
    const m2 = validateJs(c.missionDirs.m2!).stdout.split("\n").filter((l) => l.startsWith("warning: "));
    expect(m2).toEqual([`warning: ${rel(c, "m2")}/README.md: missing — M2 has no tests README; run add-tests.js to scaffold it`]);
    expect(validateJs(c.missionDirs.m3!).stdout).not.toMatch(/warning:/);
  });

  it("never changes the exit code: 0 for a well-formed entity, 1 only for its own errors", () => {
    const c = board();
    for (const dir of [c.campaignDir, ...Object.values(c.missionDirs)]) {
      expect(validateJs(dir).status).toBe(0);
      expect(validateJs(dir).stderr).toBe("");
    }
    // a mission with no criteria is invalid on its own; its pairing warnings do not change that, and still print
    const bad = synthBoard(scratch("pairing-"), [{ title: "M1 - Broken", acs: 0 }]);
    const r = validateJs(bad.missionDirs.m1!);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no acceptance criteria/);
    expect(r.stdout).toMatch(/warning: .*tests\/m1\/README\.md: missing/);
  });

  it("lists a mission's own tests README findings under the board root even when run from another cwd", () => {
    const c = board();
    const r = validateJs(relative(c.board, c.missionDirs.m2!), c.board);
    expect(r.stdout).toContain(`warning: ${rel(c, "m2")}/README.md: missing`);
  });
});

describe("validate.js <TC file>", () => {
  const goodTc = tcText(["id: TC-001", "mission: M1", "covers: [M1-AC1]", "kind: api", "status: draft"]);

  it("checks that one file, prints its warnings and exits 0", () => {
    const c = synthBoard(scratch("tcfile-"), [{ title: "M1 - Auth", acs: 2 }]);
    writeTests(c, "m1", {
      "TC-001_ok.md": goodTc,
      "TC-002_bad.md": tcText(["id: TC-009", "covers: [M1-AC1, M1-AC7]", "kind: e2e"], "none\n"),
    });
    const ok = validateJs(join(c.testsDir("m1"), "TC-001_ok.md"));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^OK /);
    expect(ok.stdout).not.toMatch(/warning:/);
    const bad = validateJs(join(c.testsDir("m1"), "TC-002_bad.md"));
    expect(bad.status).toBe(0);
    expect(bad.stderr).toBe("");
    const rel = `campaigns/${c.campaign}/tests/m1/TC-002_bad.md`;
    expect(bad.stdout.split("\n").filter((l) => l.startsWith("warning: ")).sort()).toEqual([
      `warning: ${rel}: covers names M1-AC7, which is not an acceptance criterion of M1`,
      `warning: ${rel}: id TC-009 does not match the filename prefix TC-002`,
      `warning: ${rel}: kind "e2e" is not one of api, ui, cli, unit`,
      `warning: ${rel}: missing the "## Expected Final State" section`,
      `warning: ${rel}: missing the "## Steps" section`,
    ].sort());
    // the same lines validateBoard folds into the mission's findings
    const fromBoard = boardTestsWarnings(c.board).filter((l) => l.includes("TC-002_bad.md"));
    expect(fromBoard.sort()).toEqual(bad.stdout.split("\n").filter((l) => l.startsWith("warning: ")).sort());
  });

  it("accepts a relative path and a TC whose mission is not on the board", () => {
    const c = synthBoard(scratch("tcfile-"), [{ title: "M1 - Auth", acs: 2 }]);
    writeTests(c, "m7", { "TC-001_orphan.md": tcText(["id: TC-001", "covers: [M7-AC4, M1-AC1]"]) });
    const r = validateJs("TC-001_orphan.md", c.testsDir("m7"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`campaigns/${c.campaign}/tests/m7/TC-001_orphan.md: covers names M1-AC1, which is not an acceptance criterion of M7`);
    expect(r.stdout).not.toContain("M7-AC4");
  });

  it("matches a lettered folder (m3b) to its mission", () => {
    const c = synthBoard(scratch("tcfile-"), [{ title: "M3b - Late", acs: 1 }]);
    writeTests(c, "m3b", { "TC-001_a.md": tcText(["id: TC-001", "mission: M3b", "covers: [M3b-AC1, M3b-AC2]"]) });
    const r = validateJs(join(c.testsDir("m3b"), "TC-001_a.md"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("covers names M3b-AC2, which is not an acceptance criterion of M3b");
  });

  it("exits 2 'not an entity file' for a path that is neither an entity nor a tests/m<n>/TC-*.md file", () => {
    const c = synthBoard(scratch("tcfile-"), [{ title: "M1 - Auth", acs: 1 }]);
    writeTests(c, "m1", { "README.md": readmeText([]), "notes.md": goodTc, "TC-001_a.md": goodTc });
    mkdirSync(join(c.campaignDir, "elsewhere"));
    writeFileSync(join(c.campaignDir, "elsewhere", "TC-001_a.md"), goodTc);
    mkdirSync(join(c.campaignDir, "tests", "misc"));
    writeFileSync(join(c.campaignDir, "tests", "misc", "TC-001_a.md"), goodTc);
    mkdirSync(join(c.campaignDir, "docs", "m1"), { recursive: true });
    writeFileSync(join(c.campaignDir, "docs", "m1", "TC-001_a.md"), goodTc);
    for (const p of [
      join(c.testsDir("m1"), "README.md"),
      join(c.testsDir("m1"), "notes.md"),
      join(c.campaignDir, "elsewhere", "TC-001_a.md"),
      join(c.campaignDir, "tests", "misc", "TC-001_a.md"),
      join(c.campaignDir, "docs", "m1", "TC-001_a.md"),
    ]) {
      const r = validateJs(p);
      expect(r.status, p).toBe(2);
      expect(r.stderr, p).toMatch(/not an entity file/);
    }
    expect(validateJs(join(c.campaignDir, "nope.md")).status).toBe(2);
  });
});
