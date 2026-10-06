/**
 * tc-io: the TC file frontmatter helpers and the tests-pairing rule, in both spellings (the pack's
 * dependency-free tc-io.mjs and the board library's tc-io.ts). Every case runs against both and, where
 * it produces text, against the other's output, so the two cannot drift apart.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "../src/tc-io.js";
import { readmeText, scratch, synthBoard, tcText, writeTests } from "./fixtures/tests-board.js";

type Impl = typeof ts;
const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");
const mjs = (await import(pathToFileURL(join(SCRIPTS, "tc-io.mjs")).href)) as Impl;
const impls: Array<[string, Impl]> = [["tc-io.mjs", mjs], ["tc-io.ts", ts]];

const GOOD = ["id: TC-001", "title: a", "mission: M1", "covers: [M1-AC1]", "kind: api", "status: draft"];
const problems = (impl: Impl, fm: string[], over: Partial<{ fileName: string; folder: string; acIds: Set<string> | null; body: string }> = {}): string[] =>
  impl.tcProblems({
    fileName: over.fileName ?? "TC-001_x.md",
    folder: over.folder ?? "m1",
    text: tcText(fm, over.body),
    acIds: over.acIds === undefined ? new Set(["M1-AC1", "M1-AC2"]) : over.acIds,
  });

describe.each(impls)("%s: frontmatter", (_name, io) => {
  const cases: Record<string, string> = {
    lf: "---\nid: TC-001\nstatus: draft\n---\n# Body\n\ntext\n",
    crlf: "---\r\nid: TC-001\r\nstatus: draft\r\n---\r\n# Body\r\n\r\ntext\r\n",
    bom: "﻿---\nid: TC-001\n---\nbody\n",
    "closing --- at EOF": "---\nid: TC-001\n---",
    "empty block": "---\n---\nbody\n",
    "trailing spaces on the fences": "---  \nid: TC-001\n---\t\nbody\n",
  };
  for (const [label, text] of Object.entries(cases)) {
    it(`splits ${label} so that head + yaml + tail + body is the file`, () => {
      const p = io.splitFrontmatter(text)!;
      expect(p).not.toBeNull();
      expect(p.head + p.yaml + p.tail + p.body).toBe(text);
    });
  }

  it("finds no block when the first line is not --- or the block is never closed", () => {
    expect(io.splitFrontmatter("# Title\n---\nid: x\n---\n")).toBeNull();
    expect(io.splitFrontmatter("---\nid: x\nno close\n")).toBeNull();
    expect(io.splitFrontmatter("---")).toBeNull();
    expect(io.splitFrontmatter("")).toBeNull();
  });

  it("splits at the FIRST closing --- and keeps later --- lines in the body", () => {
    const p = io.splitFrontmatter("---\nid: TC-001\n---\nbody\n---\nnot yaml\n---\n")!;
    expect(p.yaml).toBe("id: TC-001\n");
    expect(p.body).toBe("body\n---\nnot yaml\n---\n");
  });

  it("parses a block, keeps dates as strings, and reports the body", () => {
    const r = io.parseFrontmatter("---\nid: TC-001\nlast_run: {date: 2026-10-05, evidence: runs/R.md}\ncovers:\n  - M1-AC1\n---\nB\n");
    expect(r).toEqual({ ok: true, data: { id: "TC-001", last_run: { date: "2026-10-05", evidence: "runs/R.md" }, covers: ["M1-AC1"] }, body: "B\n" });
  });

  it("treats an empty block as an empty mapping", () => {
    expect(io.parseFrontmatter("---\n---\nB")).toEqual({ ok: true, data: {}, body: "B" });
    expect(io.parseFrontmatter("---\n# only a comment\n\n---\nB")).toEqual({ ok: true, data: {}, body: "B" });
    expect(io.parseFrontmatter("---\nnull\n---\nB")).toEqual({ ok: true, data: {}, body: "B" });
  });

  it("reports unparseable YAML, a non-mapping root and a missing block as not ok, with the right body", () => {
    expect(io.parseFrontmatter("---\ntitle: a: b\n---\nB\n")).toEqual({ ok: false, body: "B\n" });
    expect(io.parseFrontmatter("---\n- a\n- b\n---\nB\n")).toEqual({ ok: false, body: "B\n" });
    expect(io.parseFrontmatter("---\njust text\n---\nB\n")).toEqual({ ok: false, body: "B\n" });
    expect(io.parseFrontmatter("no block\n")).toEqual({ ok: false, body: "no block\n" });
  });

  it("serializes and parses back to the same data and body", () => {
    const data = { id: "TC-001", title: "a: b", covers: ["M1-AC1", "M1-AC2"], last_run: { date: "2026-10-05", evidence: "p" } };
    const text = io.serializeFrontmatter(data, "# T\n\nbody\n");
    expect(text.startsWith("---\nid: TC-001\ntitle: ")).toBe(true);
    expect(io.parseFrontmatter(text)).toEqual({ ok: true, data, body: "# T\n\nbody\n" });
  });

  // Mission AC: a frontmatter rewrite preserves the body byte-for-byte.
  describe("rewriteFrontmatter", () => {
    const bodies = [
      "# TC-001\n\n## Steps\n\n1. one\n\n## Expected Final State\n\nok\n",
      "line with trailing spaces   \r\n\r\n\tindented\r\n---\r\nnot frontmatter\r\n",
      "unicode: é中文 \u{1F680}\n\n\n\n",
      "no trailing newline",
      "",
    ];
    for (const body of bodies) {
      it(`keeps the body byte-for-byte (${JSON.stringify(body.slice(0, 18))}...)`, () => {
        const text = `---\nid: TC-001\nstatus: draft\npriority: high\n---\n${body}`;
        const out = io.rewriteFrontmatter(text, (d) => { d.status = "pass"; d.last_run = { date: "2026-10-06", evidence: "runs/RUN.md" }; });
        const parts = io.splitFrontmatter(out)!;
        expect(parts.body).toBe(body);
        expect(out.endsWith(body)).toBe(true);
        expect(io.parseFrontmatter(out)).toMatchObject({ ok: true, data: { id: "TC-001", status: "pass", priority: "high", last_run: { date: "2026-10-06" } } });
      });
    }

    it("keeps the fences, the BOM and CRLF line endings of the fence lines", () => {
      const text = "﻿---\r\nid: TC-001\r\n---\r\nbody\r\n";
      const out = io.rewriteFrontmatter(text, (d) => { d.status = "ready"; });
      expect(out.startsWith("﻿---\r\n")).toBe(true);
      expect(out.endsWith("---\r\nbody\r\n")).toBe(true);
    });

    it("accepts a returned object instead of a mutation, and keeps unmodelled keys", () => {
      const text = "---\nid: TC-001\nmodule: venue\ntags: [a, b]\n---\nB\n";
      const out = io.rewriteFrontmatter(text, (d) => ({ ...d, status: "blocked" }));
      expect(io.parseFrontmatter(out)).toMatchObject({ ok: true, data: { module: "venue", tags: ["a", "b"], status: "blocked" } });
    });

    it("is idempotent: rewriting twice with the same update gives the same file", () => {
      const once = io.rewriteFrontmatter("---\nid: TC-001\n---\nB\n", (d) => { d.status = "pass"; });
      expect(io.rewriteFrontmatter(once, (d) => { d.status = "pass"; })).toBe(once);
    });

    it("throws instead of guessing when the frontmatter is missing or unparseable", () => {
      expect(() => io.rewriteFrontmatter("no block\n", () => undefined)).toThrow(/missing or unparseable/);
      expect(() => io.rewriteFrontmatter("---\ntitle: a: b\n---\nB\n", () => undefined)).toThrow(/missing or unparseable/);
    });
  });
});

describe.each(impls)("%s: tcProblems (the TC format contract)", (_name, io) => {
  it("passes a complete current-format file", () => {
    expect(problems(io, GOOD)).toEqual([]);
  });

  it("never warns for extra keys (priority, size, tags, module, type, last_run, anything)", () => {
    expect(problems(io, [...GOOD, "priority: high", "size: M", "tags: [a]", "module: m", "type: functional", "last_run: {date: 2026-10-05, evidence: runs/R.md}", "whatever: 1"])).toEqual([]);
  });

  it("passes a legacy file: requirements, no status/kind/mission", () => {
    expect(problems(io, ["id: TC-001", "title: legacy", "priority: critical", "type: functional", "requirements: [M1-AC1, M1-AC2]", "tags: [x]"])).toEqual([]);
  });

  it("reads requirements only when covers is absent", () => {
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", "requirements: [M9-AC9]"])).toEqual([]);
  });

  it("warns on unparseable frontmatter and on a file without any", () => {
    for (const text of ["---\ntitle: a: b\n---\n## Steps\n## Expected Final State\n", "## Steps\n## Expected Final State\n"]) {
      expect(io.tcProblems({ fileName: "TC-001_x.md", folder: "m1", text, acIds: null })).toEqual(["frontmatter is missing or unparseable"]);
    }
  });

  it("still checks the sections of a file whose frontmatter does not parse", () => {
    expect(io.tcProblems({ fileName: "TC-001_x.md", folder: "m1", text: "---\ntitle: a: b\n---\nnothing\n", acIds: null })).toEqual([
      "frontmatter is missing or unparseable",
      'missing the "## Steps" section',
      'missing the "## Expected Final State" section',
    ]);
  });

  it("warns on a missing id, a malformed id, and an id that is not the filename prefix", () => {
    expect(problems(io, ["covers: [M1-AC1]"])).toEqual(["id is missing"]);
    expect(problems(io, ["id: TC-01", "covers: [M1-AC1]"], { fileName: "TC-01_x.md" })).toEqual(['id "TC-01" does not match TC-NNN']);
    expect(problems(io, ["id: 7", "covers: [M1-AC1]"])).toEqual(['id 7 does not match TC-NNN']);
    expect(problems(io, ["id: TC-002", "covers: [M1-AC1]"])).toEqual(["id TC-002 does not match the filename prefix TC-001"]);
    expect(problems(io, ["id: TC-1000", "covers: [M1-AC1]"], { fileName: "TC-1000.md" })).toEqual([]);
  });

  it("warns when mission is malformed or not the folder's mission; an absent mission is fine", () => {
    expect(problems(io, ["id: TC-001", "mission: m1", "covers: [M1-AC1]"])).toEqual(['mission "m1" does not match M<n>']);
    expect(problems(io, ["id: TC-001", "mission: M2", "covers: [M1-AC1]"])).toEqual(["mission M2 does not match the folder m1 (expected M1)"]);
    expect(problems(io, ["id: TC-001", "mission: M3b", "covers: [M3b-AC1]"], { folder: "m3b", acIds: new Set(["M3b-AC1"]) })).toEqual([]);
    expect(problems(io, ["id: TC-001", "mission: M3", "covers: [M3-AC1]"], { folder: "m3b", acIds: new Set(["M3b-AC1"]) })).toEqual([
      "mission M3 does not match the folder m3b (expected M3b)",
      "covers names M3-AC1, which is not an acceptance criterion of M3b",
    ]);
    expect(problems(io, ["id: TC-001", "mission: 5", "covers: [M1-AC1]"])).toEqual(['mission 5 does not match M<n>']);
  });

  it("warns when covers is missing, empty or not a list", () => {
    const msg = "covers (or legacy requirements) is missing or empty";
    expect(problems(io, ["id: TC-001"])).toEqual([msg]);
    expect(problems(io, ["id: TC-001", "covers: []"])).toEqual([msg]);
    expect(problems(io, ["id: TC-001", "requirements: []"])).toEqual([msg]);
    expect(problems(io, ["id: TC-001", "covers: M1-AC1"])).toEqual([msg]);
  });

  it("warns when covers names an AC the mission does not have, including another mission's", () => {
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1, M1-AC9]"])).toEqual(["covers names M1-AC9, which is not an acceptance criterion of M1"]);
    expect(problems(io, ["id: TC-001", "covers: [M4-AC6]"])).toEqual(["covers names M4-AC6, which is not an acceptance criterion of M1"]);
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1, M1-AC1]"])).toEqual([]); // a repeat is not a second finding
    expect(problems(io, ["id: TC-001", "covers: [AC1, 4]"])).toEqual([
      'covers names "AC1", which is not an acceptance-criterion id (M1-AC<k>)',
      "covers names 4, which is not an acceptance-criterion id (M1-AC<k>)",
    ]);
  });

  it("with the mission unknown (acIds null) checks only the mission prefix", () => {
    expect(problems(io, ["id: TC-001", "covers: [M1-AC77]"], { acIds: null })).toEqual([]);
    expect(problems(io, ["id: TC-001", "covers: [M2-AC1]"], { acIds: null })).toEqual(["covers names M2-AC1, which is not an acceptance criterion of M1"]);
  });

  it("warns on a kind or status outside the contract and accepts every contract value", () => {
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", "kind: e2e"])).toEqual(['kind "e2e" is not one of api, ui, cli, unit']);
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", "status: passed"])).toEqual(['status "passed" is not one of draft, ready, pass, fail, blocked, unknown']);
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", "status: 3"])).toEqual(['status 3 is not one of draft, ready, pass, fail, blocked, unknown']);
    for (const kind of ["api", "ui", "cli", "unit"]) expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", `kind: ${kind}`])).toEqual([]);
    for (const status of ["draft", "ready", "pass", "fail", "blocked", "unknown"]) expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", `status: ${status}`])).toEqual([]);
    expect(problems(io, ["id: TC-001", "covers: [M1-AC1]", "kind:", "status:"])).toEqual([]); // an empty value reads as absent
  });

  it("warns on each missing required section", () => {
    expect(problems(io, GOOD, { body: "## Steps\n\nx\n" })).toEqual(['missing the "## Expected Final State" section']);
    expect(problems(io, GOOD, { body: "## Expected Final State\n" })).toEqual(['missing the "## Steps" section']);
    expect(problems(io, GOOD, { body: "# only a title\n" })).toEqual(['missing the "## Steps" section', 'missing the "## Expected Final State" section']);
    expect(problems(io, GOOD, { body: "## Steps   \n## Expected Final State\t\n" })).toEqual([]); // trailing blanks are fine
    expect(problems(io, GOOD, { body: "### Steps\n## Steps and more\n## Expected Final State\n" })).toEqual(['missing the "## Steps" section']);
  });
});

describe.each(impls)("%s: parseReadmeMap", (_name, io) => {
  it("reads the AC map wherever it sits and ignores the header, separator and other tables", () => {
    const text = [
      "| Other | Table |", "|---|---|", "| a | b |", "",
      "| AC | Summary | Test cases |", "|----|---------|-----------|",
      "| M1-AC1 | first | TC-001, TC-002 |",
      "| M1-AC2 | second, with a \\| pipe | TC-003 |",
      "| `M1-AC3` | none | — |",
      "|M1-AC4|compact|TC-004,TC-004,TC-1000|",
      "| M1-AC5 | no cases column |",
      "| M1-AC6 |",
      "not a row | M1-AC7 | TC-007 |",
    ].join("\n");
    expect(io.parseReadmeMap(text)).toEqual([
      { ac: "M1-AC1", tcs: ["TC-001", "TC-002"] },
      { ac: "M1-AC2", tcs: ["TC-003"] },
      { ac: "M1-AC3", tcs: [] },
      { ac: "M1-AC4", tcs: ["TC-004", "TC-1000"] },
      { ac: "M1-AC5", tcs: [] },
      { ac: "M1-AC6", tcs: [] },
    ]);
  });

  it("takes every AC named in the first cell and does not read the Summary cell for cases", () => {
    expect(io.parseReadmeMap("| M2-AC1, M2-AC1, M2-AC2 | mentions TC-099 | TC-001 |")).toEqual([
      { ac: "M2-AC1", tcs: ["TC-001"] },
      { ac: "M2-AC2", tcs: ["TC-001"] },
    ]);
  });
});

describe.each(impls)("%s: missionTestsFindings", (_name, io) => {
  const run = (c: ReturnType<typeof synthBoard>, folder: string, over: Record<string, unknown> = {}) => {
    const dir = Object.entries(c.missionDirs).find(([f]) => f === folder)![1];
    void dir;
    return io.missionTestsFindings({
      campaignDir: c.campaignDir,
      campaign: c.campaign,
      base: c.board,
      mission: { name: `${folder.toUpperCase()} - x`, status: "executing", acceptanceCriteria: [{ text: "a", done: false }, { text: "b", done: false }], documents: [{ label: "d", target: `.octobots/campaigns/${c.campaign}/tests/${folder}/README.md` }], ...over },
    });
  };
  const rel = (c: ReturnType<typeof synthBoard>, folder: string) => `campaigns/${c.campaign}/tests/${folder}`;

  it("reports one missing-README finding for an absent folder and for a folder holding only runs/ and evidence/", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 2 }]);
    const missing = [`${rel(c, "m1")}/README.md: missing — M1 has no tests README; run add-tests.js to scaffold it`];
    expect(run(c, "m1")).toEqual(missing);
    mkdirSync(join(c.testsDir("m1"), "runs"), { recursive: true });
    mkdirSync(join(c.testsDir("m1"), "evidence"), { recursive: true });
    expect(run(c, "m1")).toEqual(missing);
  });

  it("reports an unlinked README by exact target, and a link under another target does not count", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 2 }]);
    writeTests(c, "m1", { "README.md": readmeText([]), "TC-001_a.md": tcText(["id: TC-001", "covers: [M1-AC1, M1-AC2]"]) });
    expect(run(c, "m1", { documents: [] })).toEqual([
      `${rel(c, "m1")}/README.md: not linked from the M1 documents (expected target .octobots/campaigns/${c.campaign}/tests/m1/README.md); run add-tests.js to link it`,
    ]);
    expect(run(c, "m1", { documents: [{ label: "d", target: `campaigns/${c.campaign}/tests/m1/README.md` }] })).toHaveLength(1);
    expect(run(c, "m1")).toEqual([]);
  });

  it("reports each AC no TC lists, from covers or the legacy requirements, and none for a TC with broken frontmatter", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 3 }]);
    writeTests(c, "m1", {
      "README.md": readmeText([]),
      "TC-001_a.md": tcText(["id: TC-001", "covers: [M1-AC1]"]),
      "TC-002_b.md": tcText(["id: TC-002", "requirements: [M1-AC2]"]),
      "TC-003_c.md": "---\ntitle: a: b\n---\n## Steps\n## Expected Final State\n",
    });
    const acs = Array.from({ length: 3 }, () => ({ text: "a", done: false }));
    const out = run(c, "m1", { acceptanceCriteria: acs });
    expect(out).toContain(`${rel(c, "m1")}: M1-AC3 is not covered by any test case`);
    expect(out.filter((m) => m.includes("not covered"))).toHaveLength(1);
    expect(out).toContain(`${rel(c, "m1")}/TC-003_c.md: frontmatter is missing or unparseable`);
  });

  it("reports README map rows that disagree with the frontmatter as separate findings, once each", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M3 - x", acs: 2 }]);
    writeTests(c, "m3", {
      "README.md": readmeText([["M3-AC1", "TC-001, TC-002"], ["M3-AC1", "TC-002"], ["M3-AC2", "TC-009"], ["M4-AC6", "TC-001"], ["M3-AC7", "TC-001"]]),
      "TC-001_a.md": tcText(["id: TC-001", "mission: M3", "covers: [M3-AC1, M3-AC2]"]),
      "TC-002_b.md": tcText(["id: TC-002", "mission: M3", "covers: [M3-AC2]"]),
    });
    const out = run(c, "m3");
    const readme = `${rel(c, "m3")}/README.md`;
    expect(out).toEqual([
      `${readme}: map row M3-AC1 lists TC-002, which does not list M3-AC1 in covers`,
      `${readme}: map row M3-AC2 names TC-009, which has no file in ${rel(c, "m3")}`,
      `${readme}: map row M4-AC6 is not an acceptance criterion of M3`,
      `${readme}: map row M3-AC7 is not an acceptance criterion of M3`,
    ]);
  });

  it("checks each TC file and names it by its board-relative path; non-TC entries are not TCs", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 2 }]);
    writeTests(c, "m1", {
      "README.md": readmeText([]),
      "TC-001_a.md": tcText(["id: TC-001", "covers: [M1-AC1, M1-AC2]"], "no sections\n"),
      "notes.md": "not a TC",
      "runs/TC-9_run.md": "ignored: in a subfolder",
    });
    mkdirSync(join(c.testsDir("m1"), "TC-050_dir.md"));
    expect(run(c, "m1")).toEqual([
      `${rel(c, "m1")}/TC-001_a.md: missing the "## Steps" section`,
      `${rel(c, "m1")}/TC-001_a.md: missing the "## Expected Final State" section`,
    ]);
  });

  it("reports nothing for a cancelled mission, in any spelling, and for a name without an M<n> token", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 2 }]);
    for (const status of ["cancelled", "canceled", "Cancelled"]) expect(run(c, "m1", { status })).toEqual([]);
    for (const status of ["draft", "executing", "done", "failed", "awaitingApproval", undefined]) expect(run(c, "m1", { status })).not.toEqual([]);
    expect(run(c, "m1", { name: "Mission one" })).toEqual([]);
    expect(run(c, "m1", { name: undefined })).toEqual([]);
  });

  it("uses the folder token of a lettered mission (m3b) and lower-cases the id token", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M3b - x", acs: 1 }]);
    writeTests(c, "m3b", { "README.md": readmeText([["M3b-AC1", "TC-001"]]), "TC-001_a.md": tcText(["id: TC-001", "mission: M3b", "covers: [M3b-AC1]"]) });
    const base = { campaignDir: c.campaignDir, campaign: c.campaign, base: c.board };
    const mission = { name: "M3b - x", status: "draft", acceptanceCriteria: [{ text: "a", done: false }], documents: [{ label: "d", target: `.octobots/campaigns/${c.campaign}/tests/m3b/README.md` }] };
    expect(io.missionTestsFindings({ ...base, mission })).toEqual([]);
    expect(io.missionTestsFindings({ ...base, mission: { ...mission, name: "m3B - x" } })).toEqual([]);
  });

  it("treats a tests/m<n> that is a file as an absent folder", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 1 }]);
    mkdirSync(join(c.campaignDir, "tests"), { recursive: true });
    writeFileSync(join(c.campaignDir, "tests", "m1"), "a file");
    expect(run(c, "m1")).toHaveLength(1);
  });

  // Review of T4.2: a FIFO or a symlink to /dev/zero named README.md blocked readFileSync forever, so
  // validate.js hung and validateBoard would hang the extension host. Only small regular files are read.
  it.skipIf(process.platform === "win32")("never blocks on a README or TC that is a FIFO, a symlink to a FIFO or /dev/zero", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 1 }]);
    const dir = c.testsDir("m1");
    mkdirSync(dir, { recursive: true });
    const fifo = join(c.board, "pipe");
    execFileSync("mkfifo", [fifo]);
    const missing = `${rel(c, "m1")}/README.md: missing — M1 has no tests README; run add-tests.js to scaffold it`;
    const acs = [{ text: "a", done: false }];
    execFileSync("mkfifo", [join(dir, "README.md")]);
    execFileSync("mkfifo", [join(dir, "TC-001_fifo.md")]);
    symlinkSync(fifo, join(dir, "TC-002_link.md"));
    expect(run(c, "m1", { acceptanceCriteria: acs })).toEqual([missing]);
    rmSync(join(dir, "README.md"));
    symlinkSync(fifo, join(dir, "README.md"));
    expect(run(c, "m1", { acceptanceCriteria: acs })).toEqual([missing]);
    rmSync(join(dir, "README.md"));
    symlinkSync("/dev/zero", join(dir, "README.md"));
    expect(run(c, "m1", { acceptanceCriteria: acs })).toEqual([missing]);
  });

  it("reads a README or TC over MAX_TC_BYTES as unreadable instead of loading it whole", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 1 }]);
    const big = "x".repeat(io.MAX_TC_BYTES + 1);
    writeTests(c, "m1", { "README.md": big, "TC-001_a.md": tcText(["id: TC-001", "covers: [M1-AC1]"], `## Steps\n## Expected Final State\n${big}`) });
    expect(run(c, "m1", { acceptanceCriteria: [{ text: "a", done: false }] })).toEqual([
      `${rel(c, "m1")}/README.md: missing — M1 has no tests README; run add-tests.js to scaffold it`,
      `${rel(c, "m1")}: M1-AC1 is not covered by any test case`,
      `${rel(c, "m1")}/TC-001_a.md: frontmatter is missing or unparseable`,
      `${rel(c, "m1")}/TC-001_a.md: missing the "## Steps" section`,
      `${rel(c, "m1")}/TC-001_a.md: missing the "## Expected Final State" section`,
    ]);
  });

  it("does not follow a README or TC symlink that dangles", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 1 }]);
    mkdirSync(c.testsDir("m1"), { recursive: true });
    symlinkSync(join(c.board, "nowhere.md"), join(c.testsDir("m1"), "README.md"));
    symlinkSync(join(c.board, "nowhere.md"), join(c.testsDir("m1"), "TC-001_x.md"));
    expect(run(c, "m1", { acceptanceCriteria: [{ text: "a", done: false }] })).toEqual([
      `${rel(c, "m1")}/README.md: missing — M1 has no tests README; run add-tests.js to scaffold it`,
    ]);
  });
});

describe("tc-io.mjs and tc-io.ts agree", () => {
  it("on every finding over a board that exercises each rule", () => {
    const c = synthBoard(scratch("tcio-"), [{ title: "M1 - x", acs: 3 }, { title: "M2 - y", acs: 1, linked: false }, { title: "M3 - z", acs: 2, status: "cancelled" }]);
    writeTests(c, "m1", {
      "README.md": readmeText([["M1-AC1", "TC-001, TC-009"], ["M1-AC2", "TC-001"], ["M2-AC1", "TC-001"]]),
      "TC-001_a.md": tcText(["id: TC-002", "mission: M2", "covers: [M1-AC1, M7-AC1]", "kind: web", "status: nope"], "x\n"),
      "TC-002_b.md": "---\n: bad\n---\n",
    });
    writeTests(c, "m2", { "README.md": readmeText([]) });
    const fn = (io: Impl) => Object.values({ m1: "M1 - x", m2: "M2 - y", m3: "M3 - z" }).flatMap((name) =>
      io.missionTestsFindings({
        campaignDir: c.campaignDir, campaign: c.campaign, base: c.board,
        mission: { name, status: name.startsWith("M3") ? "cancelled" : "draft", acceptanceCriteria: Array.from({ length: name.startsWith("M1") ? 3 : 1 }, () => ({ text: "a", done: false })), documents: name.startsWith("M1") ? [{ label: "d", target: `.octobots/campaigns/${c.campaign}/tests/m1/README.md` }] : [] },
      }));
    const a = fn(mjs);
    expect(a.length).toBeGreaterThan(8);
    expect(fn(ts)).toEqual(a);
  });
});
