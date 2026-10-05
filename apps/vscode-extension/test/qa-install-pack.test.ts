import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";

const SCRIPT = fileURLToPath(new URL("../scripts/qa/install-pack.mjs", import.meta.url));
const PACK = fileURLToPath(new URL("../resources/octobots-pack", import.meta.url));

interface Status { installed: boolean; currentVersion: number; upToDate: boolean; upToDateExceptLocal: boolean; deviations: unknown[]; newer: unknown[] }
interface Report {
  before: Status;
  result: { written: number; hooksRegistered: boolean; statusline: string; tools: string };
  after: Status;
}

function run(args: string[]): Report {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })) as Report;
}

describe("scripts/qa/install-pack.mjs", () => {
  it("prints {before, result, after} for a temp workspace: not installed, then installed and up to date", () => {
    const ws = mkdtempClean("qa-install-");
    const report = run([ws]);

    expect(Object.keys(report).sort()).toEqual(["after", "before", "result"]);
    expect(report.before).toMatchObject({ installed: false, currentVersion: OCTOBOTS_PACK_VERSION, upToDate: false, upToDateExceptLocal: false });
    expect(report.result.written).toBeGreaterThan(0);
    expect(report.result.tools).toBe("skipped");
    expect(report.after).toMatchObject({ installed: true, currentVersion: OCTOBOTS_PACK_VERSION, upToDate: true, deviations: [], newer: [] });
    expect(existsSync(join(ws, ".claude", "skills", "mission-planner", "SKILL.md"))).toBe(true);
  });

  it("--pack-root installs from the given directory instead of the bundled pack", () => {
    const ws = mkdtempClean("qa-install-");
    const root = mkdtempClean("qa-pack-");
    cpSync(PACK, root, { recursive: true });
    const marker = join(root, "skill", "mission-planner", "SKILL.md");
    writeFileSync(marker, readFileSync(marker, "utf8") + "\nCOPIED-PACK-MARKER\n");

    const report = run([ws, "--pack-root", root]);

    expect(report.after.upToDate).toBe(true);
    expect(readFileSync(join(ws, ".claude", "skills", "mission-planner", "SKILL.md"), "utf8")).toContain("COPIED-PACK-MARKER");
  });

  it("exits 1 with the error on stderr when the install throws (pack root has no skills)", () => {
    const ws = mkdtempClean("qa-install-");
    const empty = mkdtempClean("qa-empty-");
    mkdirSync(join(empty, "skill"), { recursive: true });
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, ws, "--pack-root", empty], { stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
      stderr = String((e as { stderr: Buffer }).stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/install-pack/);
  });

  it("exits 2 with a usage line when no workspace is given", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT], { stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
