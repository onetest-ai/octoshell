/**
 * Malformed and legacy test cases (mission M6 AC2): they are still LISTED, they only ever WARN (never an
 * error), and a legacy file lists as `unknown` with the one-line migrate suggestion. Everything here runs
 * on a synthetic board, so every message and field is exact.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardModel } from "../src/board-model.js";
import { validateBoard } from "../src/validate.js";
import { dumpEntity, loadEntity } from "../src/entity-schema.js";
import { readmeText, scratch, synthBoard, tcText, writeTests } from "./fixtures/tests-board.js";

const HINT = "legacy test case (no status, kind or mission) lists as unknown: run set-test-status.js <tc-file> --migrate";
const GOOD = ["id: TC-001", "title: good", "mission: M1", "covers: [M1-AC1]", "kind: api", "status: pass"];

function board() {
  const root = scratch("tc-malformed-");
  const c = synthBoard(root, [{ title: "M1 - Auth", acs: 3 }]);
  const base = "campaigns/" + c.campaign + "/tests/m1";
  writeTests(c, "m1", {
    "README.md": readmeText([["M1-AC1", "TC-001"], ["M1-AC2", "TC-002"]]),
    "TC-001_good.md": tcText(GOOD),
    "TC-002_legacy.md": tcText(["id: TC-002", "title: legacy one", "requirements: [M1-AC2]", "priority: high"], "# TC-002: Legacy heading\n\n## Steps\n\n1. x\n\n## Expected Final State\n\nok\n"),
    "TC-003_broken.md": "---\nid: [unclosed\ntitle: x\n---\n\n## Steps\n\n## Expected Final State\n",
    "TC-004_values.md": tcText(["id: TC-004", "title: bad values", "mission: M1", "covers: [M1-AC3]", "kind: e2e", "status: nope"]),
    "TC-005_ids.md": tcText(["id: TC-009", "title: id mismatch", "mission: M1", "covers: [M1-AC3]", "kind: ui", "status: ready"]),
    "TC-006_nofm.md": "# just a heading\n\n## Steps\n\n## Expected Final State\n",
    "TC-007_lastrun.md": tcText(["id: TC-007", "title: ran", "mission: M1", "covers: [M1-AC3]", "kind: cli", "status: fail", "last_run: {date: 2026-10-05, evidence: .octobots/x/RUN-1.md}"]),
    "runs/TC-098_not-a-tc.md": "---\nid: TC-098\n---\n",
    "evidence/TC-099_not-a-tc.md": "---\nid: TC-099\n---\n",
  });
  mkdirSync(join(c.testsDir("m1"), "TC-077_dir.md"));
  return { root, c, base };
}

const find = (cases: ReturnType<BoardModel["listTestCases"]>, id: string) => cases.find((t) => t.id === id)!;

describe("malformed and legacy test cases", () => {
  it("lists every TC-*.md file (and nothing else) with lenient fields", () => {
    const { root, c, base } = board();
    const m = new BoardModel(root);
    m.rebuild();
    const cid = m.listCampaigns()[0]!.id;
    const cases = m.listTestCases(cid);
    expect(cases.map((t) => t.path).sort()).toEqual([
      `${base}/TC-001_good.md`, `${base}/TC-002_legacy.md`, `${base}/TC-003_broken.md`, `${base}/TC-004_values.md`,
      `${base}/TC-005_ids.md`, `${base}/TC-006_nofm.md`, `${base}/TC-007_lastrun.md`,
    ]);

    expect(find(cases, "TC-001")).toEqual({ id: "TC-001", title: "good", mission: "M1", covers: ["M1-AC1"], kind: "api", status: "pass", path: `${base}/TC-001_good.md` });
    // legacy: `requirements` is the alias of `covers`, mission comes from the folder, no status -> unknown, title falls back to frontmatter title
    expect(find(cases, "TC-002")).toEqual({ id: "TC-002", title: "legacy one", mission: "M1", covers: ["M1-AC2"], kind: null, status: "unknown", path: `${base}/TC-002_legacy.md` });
    // unparseable frontmatter: still listed; id from the filename, mission from the folder
    expect(find(cases, "TC-003")).toMatchObject({ mission: "M1", covers: [], kind: null, status: "unknown" });
    // unknown status / kind values read as unknown / null
    expect(find(cases, "TC-004")).toMatchObject({ kind: null, status: "unknown", covers: ["M1-AC3"] });
    // the file name is the identity; the frontmatter id disagreeing is only a warning
    expect(find(cases, "TC-005").id).toBe("TC-005");
    // no frontmatter: title from the first H1 or the stem
    expect(find(cases, "TC-006")).toMatchObject({ title: "just a heading", status: "unknown", covers: [] });
    expect(find(cases, "TC-007").lastRun).toEqual({ date: "2026-10-05", evidence: ".octobots/x/RUN-1.md" });
    expect(find(cases, "TC-001").lastRun).toBeUndefined();
    expect(c.campaign).toBeTruthy();
  });

  it("warns (never errors) on malformed and legacy files, with the migrate suggestion on the legacy one only", () => {
    const { root, c, base } = board();
    const findings = validateBoard(root);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const msgs = findings.filter((f) => f.message.includes("/TC-")).map((f) => f.message);
    expect(msgs).toContain(`${base}/TC-002_legacy.md: ${HINT}`);
    expect(msgs.filter((m) => m.includes("--migrate"))).toEqual([`${base}/TC-002_legacy.md: ${HINT}`]);
    expect(msgs).toContain(`${base}/TC-003_broken.md: frontmatter is missing or unparseable`);
    expect(msgs).toContain(`${base}/TC-004_values.md: status "nope" is not one of draft, ready, pass, fail, blocked, unknown`);
    expect(msgs).toContain(`${base}/TC-004_values.md: kind "e2e" is not one of api, ui, cli, unit`);
    expect(msgs).toContain(`${base}/TC-005_ids.md: id TC-009 does not match the filename prefix TC-005`);
    expect(msgs.some((m) => m.startsWith(`${base}/TC-001_good.md`))).toBe(false);
    expect(msgs.some((m) => m.includes("TC-098") || m.includes("TC-099") || m.includes("TC-077"))).toBe(false);
    expect(c.campaign).toBeTruthy();
  });

  it("a file that cannot be read safely is still listed, as unknown (oversize, FIFO)", () => {
    const { root, c, base } = board();
    const big = join(c.testsDir("m1"), "TC-008_big.md");
    writeFileSync(big, "---\nid: TC-008\nstatus: pass\n---\n" + "x".repeat(4194304 + 1));
    execFileSync("mkfifo", [join(c.testsDir("m1"), "TC-009_fifo.md")]);
    const m = new BoardModel(root);
    m.rebuild();
    const cases = m.listTestCases(m.listCampaigns()[0]!.id);
    expect(find(cases, "TC-008")).toMatchObject({ status: "unknown", path: `${base}/TC-008_big.md` });
    expect(cases.some((t) => t.id === "TC-009")).toBe(false);
  });

  it("lists the same files whatever the malformation, so validate and the list never disagree on the file set", () => {
    const { root } = board();
    const m = new BoardModel(root);
    m.rebuild();
    const listed = new Set(m.listTestCases(m.listCampaigns()[0]!.id).map((t) => t.path.split("/").pop()));
    const warned = new Set(validateBoard(root).map((f) => /\/(TC-[^:/]+\.md): /.exec(f.message)?.[1]).filter(Boolean));
    for (const f of warned) expect(listed.has(f)).toBe(true);
  });

  it("getTestCoverage keeps a multi-line criterion whole and numbers criteria as the YAML does (solo h0004 m2/m6/m9)", () => {
    const root = scratch("tc-multiline-");
    const c = synthBoard(root, [{ title: "M1 - Auth", acs: 3 }]);
    const file = join(c.missionDirs.m1!, "mission.yaml");
    const fields = loadEntity(readFileSync(file, "utf8"));
    // the second criterion spans lines, and one of its lines even looks like a checklist item
    const multi = "A row carries: session_id\n(FK, NOT NULL), match_id\n- [ ] not a criterion of its own";
    fields.acceptanceCriteria = [{ text: "first", done: true }, { text: multi, done: false }, { text: "third", done: false }];
    writeFileSync(file, dumpEntity("mission", fields), "utf8");
    writeTests(c, "m1", { "README.md": readmeText([]), "TC-001_a.md": tcText(["id: TC-001", "title: a", "mission: M1", "covers: [M1-AC2]", "kind: api", "status: pass"]) });
    const m = new BoardModel(root);
    m.rebuild();
    const cov = m.getTestCoverage(m.listMissions(m.listCampaigns()[0]!.id)[0]!.id);
    expect(cov.acs).toEqual([
      { ac: "M1-AC1", text: "first", tcs: [], covered: false },
      { ac: "M1-AC2", text: multi, tcs: ["TC-001"], covered: true },
      { ac: "M1-AC3", text: "third", tcs: [], covered: false },
    ]);
    expect(cov.uncovered).toEqual(["M1-AC1", "M1-AC3"]);
    // and validate numbers them the same way
    const warned = validateBoard(root).map((f) => / (M1-AC\d+) is not covered/.exec(f.message)?.[1]).filter(Boolean);
    expect(warned).toEqual(cov.uncovered);
  });
});
