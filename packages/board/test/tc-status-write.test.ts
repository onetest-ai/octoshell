/**
 * writeTestCaseStatus / editTestCaseStatus (packages/board/src/tc-status.ts): the file writer's refusals,
 * the atomic write, `expect` (stale-base check), `skipIfCurrent` (the host's documented deviation from
 * set-test-status.js) and the final re-read before the rename. Byte parity with the script is
 * tc-status-parity.test.ts.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TC_BYTES, editTestCaseStatus, writeTestCaseStatus } from "../src/index.js";
import { scratchDir } from "./fixtures/real-board.js";

const BODY = "\n# TC-001: Example\n\n## Steps\n\n| # | Action | Expected Result |\n|---|--------|----------------|\n| 1 | a | b |\n\n## Expected Final State\n\nDone.\n";
const tc = (fm: string): string => `---\n${fm}---\n${BODY}`;
const READY = tc("id: TC-001\nmission: M1\nstatus: ready\nkind: unit\n");
const FAILED = tc("id: TC-001\nmission: M1\nstatus: fail\nlast_run: {date: 2026-10-01, evidence: runs/RUN-1.md}\nkind: unit\n");
const REL = "campaigns/c1/tests/m1/TC-001_example.md";

/** A board with one TC at REL holding `text`. */
function board(text: string, rel = REL): { root: string; file: string; dir: string } {
  const root = join(scratchDir("tc-status-write-"), ".octobots");
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return { root, file, dir: join(file, "..") };
}

describe("editTestCaseStatus (the pure edit)", () => {
  it("replaces status in place and writes last_run {date} after it for a run status, leaving the body byte for byte", () => {
    const r = editTestCaseStatus(FAILED, "pass", "2026-10-06");
    expect(r).toEqual({ ok: true, changed: true, text: tc("id: TC-001\nmission: M1\nstatus: pass\nlast_run: {date: 2026-10-06}\nkind: unit\n") });
  });

  it("leaves last_run alone for draft and ready, and ignores a date given with them", () => {
    expect(editTestCaseStatus(FAILED, "ready", null)).toEqual({ ok: true, changed: true, text: FAILED.replace("status: fail", "status: ready") });
    expect(editTestCaseStatus(FAILED, "draft", "2026-10-06")).toEqual({ ok: true, changed: true, text: FAILED.replace("status: fail", "status: draft") });
  });

  it("re-dates last_run for a run status the file already holds, as the script does", () => {
    const r = editTestCaseStatus(FAILED, "fail", "2026-10-06");
    expect(r).toEqual({ ok: true, changed: true, text: FAILED.replace("last_run: {date: 2026-10-01, evidence: runs/RUN-1.md}", "last_run: {date: 2026-10-06}") });
  });

  it("reports changed: false and the same text when nothing would change", () => {
    const same = tc("id: TC-001\nstatus: pass\nlast_run: {date: 2026-10-06}\n");
    expect(editTestCaseStatus(same, "pass", "2026-10-06")).toEqual({ ok: true, changed: false, text: same });
    expect(editTestCaseStatus(READY, "ready", null)).toEqual({ ok: true, changed: false, text: READY });
  });

  it("refuses an invalid status, and a run status with no calendar date", () => {
    expect(editTestCaseStatus(READY, "unknown" as never, null)).toMatchObject({ ok: false, reason: "invalid-status" });
    expect(editTestCaseStatus(READY, "pass", null)).toMatchObject({ ok: false, reason: "invalid-date" });
    expect(editTestCaseStatus(READY, "pass", "2026-02-30")).toMatchObject({ ok: false, reason: "invalid-date" });
    expect(editTestCaseStatus(READY, "pass", "10/06/2026")).toMatchObject({ ok: false, reason: "invalid-date" });
  });

  it("refuses a file with no frontmatter, unparseable frontmatter and an edit it cannot prove", () => {
    expect(editTestCaseStatus(BODY, "pass", "2026-10-06")).toMatchObject({ ok: false, reason: "no-frontmatter" });
    expect(editTestCaseStatus(tc("id: [x\n"), "pass", "2026-10-06")).toMatchObject({ ok: false, reason: "unparseable" });
    expect(editTestCaseStatus(tc("id: TC-001\n\"status\": draft\n"), "pass", "2026-10-06")).toMatchObject({ ok: false, reason: "unsafe" });
  });
});

describe("writeTestCaseStatus: what it refuses", () => {
  it("writes a symlinked TC file through nothing: the link and its target are untouched", () => {
    const b = board(READY);
    const link = join(b.dir, "TC-002_link.md");
    symlinkSync(b.file, link);
    const r = writeTestCaseStatus(b.root, "campaigns/c1/tests/m1/TC-002_link.md", { status: "pass", date: "2026-10-06" });
    expect(r).toMatchObject({ ok: false, reason: "symlink" });
    expect(readFileSync(b.file, "utf8")).toBe(READY);
    expect(statSync(link).isFile()).toBe(true);
    expect(readdirSync(b.dir).sort()).toEqual(["TC-001_example.md", "TC-002_link.md"]);
  });

  it("refuses a symlinked m<n> folder and a symlinked tests folder", () => {
    const b = board(READY);
    const root = b.root;
    // m1 -> m1-real
    const testsDir = join(root, "campaigns/c1/tests");
    renameSync(join(testsDir, "m1"), join(testsDir, "m1-real"));
    symlinkSync(join(testsDir, "m1-real"), join(testsDir, "m1"));
    expect(writeTestCaseStatus(root, REL, { status: "pass", date: "2026-10-06" })).toMatchObject({ ok: false, reason: "symlink" });
    expect(readFileSync(join(testsDir, "m1-real/TC-001_example.md"), "utf8")).toBe(READY);
    expect(readdirSync(join(testsDir, "m1-real"))).toEqual(["TC-001_example.md"]);

    // tests -> tests-real
    const b2 = board(READY);
    const c1b = join(b2.root, "campaigns/c1");
    renameSync(join(c1b, "tests"), join(c1b, "tests-real"));
    symlinkSync(join(c1b, "tests-real"), join(c1b, "tests"));
    expect(writeTestCaseStatus(b2.root, REL, { status: "pass", date: "2026-10-06" })).toMatchObject({ ok: false, reason: "symlink" });
    expect(readFileSync(join(c1b, "tests-real/m1/TC-001_example.md"), "utf8")).toBe(READY);
  });

  it("refuses a path that is not campaigns/<c>/tests/m<n>/TC-*.md", () => {
    const b = board(READY);
    writeFileSync(join(b.dir, "README.md"), "# readme\n");
    mkdirSync(join(b.root, "campaigns/c1/missions/m1"), { recursive: true });
    writeFileSync(join(b.root, "campaigns/c1/missions/m1/mission.yaml"), "name: M1\n");
    writeFileSync(join(b.dir, "TC-003_x.txt"), READY);
    mkdirSync(join(b.root, "campaigns/c1/tests/notes"), { recursive: true });
    writeFileSync(join(b.root, "campaigns/c1/tests/notes/TC-001_x.md"), READY);
    for (const rel of [
      "campaigns/c1/tests/m1/README.md",
      "campaigns/c1/missions/m1/mission.yaml",
      "campaigns/c1/tests/m1/TC-003_x.txt",
      "campaigns/c1/tests/notes/TC-001_x.md",
      "campaigns/c1/tests/m1/../m1/TC-001_example.md",
      "../outside/campaigns/c1/tests/m1/TC-001_example.md",
      join(b.root, REL),
      "campaigns/tests/m1/TC-001_example.md",
      "tests/m1/TC-001_example.md",
      "campaigns\\c1\\tests\\m1\\TC-001_example.md",
      "campaigns/c1/tests/m1/TC-001\u0000.md",
      "campaigns/c1/tests/m1/TC-001\n.md",
      "",
    ]) {
      expect(writeTestCaseStatus(b.root, rel, { status: "pass", date: "2026-10-06" }), JSON.stringify(rel)).toMatchObject({ ok: false, reason: "not-a-test-case" });
    }
    expect(readFileSync(b.file, "utf8")).toBe(READY);
    expect(readFileSync(join(b.dir, "TC-003_x.txt"), "utf8")).toBe(READY);
  });

  it("refuses a TC that is not there", () => {
    const b = board(READY);
    expect(writeTestCaseStatus(b.root, "campaigns/c1/tests/m1/TC-009_gone.md", { status: "pass", date: "2026-10-06" })).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("refuses a file over MAX_TC_BYTES, and a FIFO, without reading or writing them", () => {
    const big = board(READY + "x".repeat(MAX_TC_BYTES));
    expect(statSync(big.file).size).toBeGreaterThan(MAX_TC_BYTES);
    expect(writeTestCaseStatus(big.root, REL, { status: "pass", date: "2026-10-06" })).toMatchObject({ ok: false, reason: "too-large" });
    expect(readdirSync(big.dir)).toEqual(["TC-001_example.md"]);

    const b = board(READY);
    const fifo = join(b.dir, "TC-002_fifo.md");
    execFileSync("mkfifo", [fifo]);
    expect(writeTestCaseStatus(b.root, "campaigns/c1/tests/m1/TC-002_fifo.md", { status: "pass", date: "2026-10-06" })).toMatchObject({ ok: false, reason: "not-regular" });
    expect(readdirSync(b.dir).sort()).toEqual(["TC-001_example.md", "TC-002_fifo.md"]);
  });

  it("refuses no frontmatter, unparseable frontmatter and an unprovable edit, leaving the file and the folder as they were", () => {
    for (const [text, reason, status] of [
      [BODY, "no-frontmatter", "pass"],
      [tc("id: [x\n"), "unparseable", "pass"],
      [tc("id: TC-001\nstatus: &s draft\nprev: *s\n"), "unsafe", "pass"],
      // ready re-parses cleanly but would drop `kind`: only the re-parse DATA comparison refuses it
      [tc("{id: TC-001,\nstatus: draft, kind: unit\n}\n"), "unsafe", "ready"],
    ] as const) {
      const b = board(text);
      const date = status === "pass" ? "2026-10-06" : null;
      expect(writeTestCaseStatus(b.root, REL, { status, date }), reason).toMatchObject({ ok: false, reason });
      expect(readFileSync(b.file, "utf8")).toBe(text);
      expect(readdirSync(b.dir)).toEqual(["TC-001_example.md"]);
    }
  });

  it("refuses an invalid status or date before touching anything", () => {
    const b = board(READY);
    expect(writeTestCaseStatus(b.root, REL, { status: "pass", date: null })).toMatchObject({ ok: false, reason: "invalid-date" });
    expect(writeTestCaseStatus(b.root, REL, { status: "unknown" as never, date: null })).toMatchObject({ ok: false, reason: "invalid-status" });
    expect(readFileSync(b.file, "utf8")).toBe(READY);
  });
});

describe("writeTestCaseStatus: the atomic write", () => {
  it("writes the edit, keeps the file mode and leaves no temp file", () => {
    const b = board(FAILED);
    chmodSync(b.file, 0o640);
    const r = writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06" });
    expect(r).toEqual({ ok: true, changed: true });
    expect(readFileSync(b.file, "utf8")).toBe(FAILED.replace("status: fail\nlast_run: {date: 2026-10-01, evidence: runs/RUN-1.md}", "status: pass\nlast_run: {date: 2026-10-06}"));
    expect(statSync(b.file).mode & 0o7777).toBe(0o640);
    expect(readdirSync(b.dir)).toEqual(["TC-001_example.md"]);
  });

  // Root ignores directory write permission, so a 0o555 folder cannot make the write fail there (same guard as
  // pack-updates-hardening.test.ts); CI and dev machines run as a normal user, where this always runs.
  it.runIf(process.getuid?.() !== 0)("leaves the TC unchanged and no temp file when the folder cannot be written (the temp file is the first write)", () => {
    const b = board(READY);
    chmodSync(b.dir, 0o555);
    try {
      const r = writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06" });
      expect(r).toMatchObject({ ok: false, reason: "write-failed" });
    } finally {
      chmodSync(b.dir, 0o755);
    }
    expect(readFileSync(b.file, "utf8")).toBe(READY);
    expect(readdirSync(b.dir)).toEqual(["TC-001_example.md"]);
  });

  it("returns stale, writes nothing and leaves no temp file when the bytes move between the temp write and the rename", () => {
    const b = board(READY);
    const moved = tc("id: TC-001\nmission: M1\nstatus: fail\nlast_run: {date: 2026-10-05, evidence: runs/RUN-9.md}\nkind: unit\n");
    let seen: { file: string; tmp: string } | null = null;
    const r = writeTestCaseStatus(b.root, REL, {
      status: "pass",
      date: "2026-10-06",
      beforeFinalRead: (paths) => {
        seen = paths;
        expect(existsSync(paths.tmp)).toBe(true); // the hook runs with the temp file written
        writeFileSync(paths.file, moved); // an agent's set-test-status.js lands here
      },
    });
    expect(seen).not.toBeNull();
    expect(r).toMatchObject({ ok: false, reason: "stale", current: { status: "fail", lastRun: { date: "2026-10-05", evidence: "runs/RUN-9.md" } } });
    expect(readFileSync(b.file, "utf8")).toBe(moved);
    expect(readdirSync(b.dir)).toEqual(["TC-001_example.md"]);
  });
});

describe("writeTestCaseStatus: expect (the panel's view) and skipIfCurrent (the host's no-op)", () => {
  it("returns stale with the file's current status and last run, and writes nothing, when expect is not what the file holds", () => {
    const b = board(FAILED);
    const before = statSync(b.file).mtimeMs;
    const r = writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06", expect: { status: "ready", lastRun: null } });
    expect(r).toMatchObject({ ok: false, reason: "stale", current: { status: "fail", lastRun: { date: "2026-10-01", evidence: "runs/RUN-1.md" } } });
    expect(readFileSync(b.file, "utf8")).toBe(FAILED);
    expect(statSync(b.file).mtimeMs).toBe(before);
    expect(readdirSync(b.dir)).toEqual(["TC-001_example.md"]);
  });

  it("returns stale when the status matches but the last run moved, and when an evidence link differs", () => {
    const b = board(FAILED);
    for (const lastRun of [null, { date: "2026-10-02", evidence: "runs/RUN-1.md" }, { date: "2026-10-01" }, { date: "2026-10-01", evidence: "runs/RUN-2.md" }]) {
      const r = writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06", expect: { status: "fail", lastRun } });
      expect(r, JSON.stringify(lastRun)).toMatchObject({ ok: false, reason: "stale" });
    }
    expect(readFileSync(b.file, "utf8")).toBe(FAILED);
  });

  it("writes when expect equals what the file holds (a legacy file lists as unknown with no last run)", () => {
    const legacy = tc("id: TC-001\ntitle: old\nrequirements: [M1-AC1]\ntype: functional\n");
    const b = board(legacy);
    const r = writeTestCaseStatus(b.root, REL, { status: "ready", date: null, expect: { status: "unknown", lastRun: null } });
    expect(r).toEqual({ ok: true, changed: true });
    expect(readFileSync(b.file, "utf8")).toBe(tc("id: TC-001\ntitle: old\nrequirements: [M1-AC1]\ntype: functional\nstatus: ready\n"));

    const b2 = board(FAILED);
    const r2 = writeTestCaseStatus(b2.root, REL, { status: "pass", date: "2026-10-06", expect: { status: "fail", lastRun: { date: "2026-10-01", evidence: "runs/RUN-1.md" } } });
    expect(r2).toEqual({ ok: true, changed: true });
  });

  it("with skipIfCurrent, requesting the status the file holds writes nothing: bytes and mtime unchanged, even for pass", () => {
    const passed = tc("id: TC-001\nstatus: pass\nlast_run: {date: 2026-09-01, evidence: runs/RUN-1.md}\n");
    const b = board(passed);
    const old = new Date("2026-09-01T10:00:00Z");
    utimesSync(b.file, old, old);
    const before = statSync(b.file).mtimeMs;
    expect(writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06", skipIfCurrent: true })).toEqual({ ok: true, changed: false });
    expect(readFileSync(b.file, "utf8")).toBe(passed);
    expect(statSync(b.file).mtimeMs).toBe(before);
    expect(readdirSync(b.dir)).toEqual(["TC-001_example.md"]);
  });

  it("without skipIfCurrent the result equals the script's: pass on a pass file re-dates last_run and drops the evidence", () => {
    const passed = tc("id: TC-001\nstatus: pass\nlast_run: {date: 2026-09-01, evidence: runs/RUN-1.md}\n");
    const b = board(passed);
    expect(writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06" })).toEqual({ ok: true, changed: true });
    expect(readFileSync(b.file, "utf8")).toBe(tc("id: TC-001\nstatus: pass\nlast_run: {date: 2026-10-06}\n"));
  });

  it("reports changed: false and writes nothing when the edit changes nothing (pass on the same date)", () => {
    const passed = tc("id: TC-001\nstatus: pass\nlast_run: {date: 2026-10-06}\n");
    const b = board(passed);
    const old = new Date("2026-10-06T10:00:00Z");
    utimesSync(b.file, old, old);
    const before = statSync(b.file).mtimeMs;
    expect(writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06" })).toEqual({ ok: true, changed: false });
    expect(statSync(b.file).mtimeMs).toBe(before);
  });

  it("checks expect before skipIfCurrent: a stale view is stale even when the file already holds the requested status", () => {
    const b = board(tc("id: TC-001\nstatus: pass\nlast_run: {date: 2026-10-06}\n"));
    const r = writeTestCaseStatus(b.root, REL, { status: "pass", date: "2026-10-06", skipIfCurrent: true, expect: { status: "ready", lastRun: null } });
    expect(r).toMatchObject({ ok: false, reason: "stale", current: { status: "pass" } });
  });
});
