import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { forks } from "./fixtures/pack-store.js";
import { skillSha256 } from "../src/host/skill-marker.js";

const SCRIPT = fileURLToPath(new URL("../scripts/qa/install-pack.mjs", import.meta.url));
const PACK = fileURLToPath(new URL("../resources/octobots-pack", import.meta.url));

interface Status {
  installed: boolean; currentVersion: number; upToDate: boolean; upToDateExceptLocal: boolean;
  deviations: Array<{ skill: string; version: string; reason: string; retired: boolean; sha256: string }>;
  reconciled: string[]; pendingReconcile: string[]; newer: unknown[];
}
interface Report {
  before: Status;
  deviations: Status["deviations"];
  result: { written: number; hooksRegistered: boolean; statusline: string; tools: string; pending: string[]; kept: string[]; keptFiles: string[] };
  after: Status;
}

function run(args: string[]): Report {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })) as Report;
}

describe("scripts/qa/install-pack.mjs", () => {
  it("prints {before, result, after} for a temp workspace: not installed, then installed and up to date", () => {
    const ws = mkdtempClean("qa-install-");
    const report = run([ws]);

    expect(Object.keys(report).sort()).toEqual(["after", "before", "deviations", "result"]);
    expect(report.deviations).toEqual([]);
    expect(report.result).toMatchObject({ pending: [], kept: [], keptFiles: [] });
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

    // The copied file is not one the store lists, so it is (rightly) reported as a content deviation.
    expect(report.after.deviations.map((d) => [d.skill, d.reason])).toEqual([["mission-planner", "content"]]);
    expect(report.after.upToDateExceptLocal).toBe(true);
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

describe("scripts/qa/install-pack.mjs: local changes", () => {
  const f = forks();
  const FORK = f["mission-execution"];

  /** A temp workspace holding the pack and one `57-local` skill (solo's mission-execution fork). */
  function forked(): string {
    const ws = mkdtempClean("qa-install-");
    run([ws]);
    writeFileSync(join(ws, ".claude", "skills", "mission-execution", "SKILL.md"), FORK);
    return ws;
  }
  const live = (ws: string) => readFileSync(join(ws, ".claude", "skills", "mission-execution", "SKILL.md"));
  const go = (args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, report: r.stdout ? (JSON.parse(r.stdout) as Report) : null };
  };
  const expectedDeviation = { skill: "mission-execution", version: "57-local", reason: "label", retired: false, sha256: skillSha256(FORK.toString("utf8")) };

  it("defaults to reconcile: stages the skill, keeps the file, and says so on stderr", () => {
    const ws = forked();
    const { status, stderr, report } = go([ws]);
    expect(status).toBe(0);
    expect(stderr.trim()).toBe("1 skill(s) need reconcile");
    expect(report!.before.deviations).toEqual([expectedDeviation]);
    expect(report!.deviations).toEqual([expectedDeviation]);
    expect(report!.before.upToDate).toBe(false);
    expect(report!.result).toMatchObject({ pending: ["mission-execution"], kept: [], keptFiles: [] });
    expect(report!.after.pendingReconcile).toEqual(["mission-execution"]);
    expect(report!.after.deviations).toEqual([expectedDeviation]);
    expect(live(ws).equals(FORK)).toBe(true);
    expect(existsSync(join(ws, ".octobots", "pack-updates", `v${OCTOBOTS_PACK_VERSION}`, "mission-execution", "RECONCILE.md"))).toBe(true);
  });

  it("--local-changes=reconcile is the same as the default", () => {
    expect(go([forked(), "--local-changes=reconcile"]).report!.result.pending).toEqual(["mission-execution"]);
  });

  it("keep, then a default run (no flag): kept unchanged, nothing staged; an explicit reconcile re-opens it", () => {
    const ws = forked();
    expect(go([ws, "--local-changes=keep"]).report!.result).toMatchObject({ pending: [], kept: ["mission-execution"] });
    const again = go([ws]);
    expect(again.status).toBe(0);
    expect(again.stderr).toBe("");
    expect(again.report!.result).toMatchObject({ pending: [], kept: ["mission-execution"] });
    expect(again.report!.after.pendingReconcile).toEqual([]);
    expect(live(ws).equals(FORK)).toBe(true);
    expect(existsSync(join(ws, ".octobots", "pack-updates", `v${OCTOBOTS_PACK_VERSION}`))).toBe(false);

    const reopened = go([ws, "--local-changes=reconcile"]);
    expect(reopened.report!.result).toMatchObject({ pending: ["mission-execution"], kept: [] });
  });

  it("--local-changes=overwrite replaces the file, saves the old one, and prints no stderr line", () => {
    const ws = forked();
    const { status, stderr, report } = go([ws, "--local-changes=overwrite"]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(report!.deviations).toEqual([expectedDeviation]);
    expect(report!.result).toMatchObject({ pending: [], kept: [] });
    expect(report!.after).toMatchObject({ deviations: [], pendingReconcile: [], upToDate: true });
    expect(live(ws).equals(FORK)).toBe(false);
    expect(readFileSync(join(ws, ".octobots", "pack-updates", `v${OCTOBOTS_PACK_VERSION}`, "mission-execution", "overwritten-local.md")).equals(FORK)).toBe(true);
  });

  it("--local-changes=keep leaves the file, records it as kept and stages nothing", () => {
    const ws = forked();
    const { stderr, report } = go([ws, "--local-changes=keep"]);
    expect(stderr).toBe("");
    expect(report!.result).toMatchObject({ pending: [], kept: ["mission-execution"] });
    expect(report!.after).toMatchObject({ pendingReconcile: [], upToDate: false, upToDateExceptLocal: true });
    expect(live(ws).equals(FORK)).toBe(true);
    expect(existsSync(join(ws, ".octobots", "pack-updates", `v${OCTOBOTS_PACK_VERSION}`))).toBe(false);
  });

  it("--pack-version 58 stages under v58", () => {
    const ws = forked();
    const { stderr, report } = go([ws, "--pack-version", "58"]);
    expect(report!.before.currentVersion).toBe(58);
    expect(report!.result.pending).toEqual(["mission-execution"]);
    expect(stderr.trim()).toBe("1 skill(s) need reconcile");
    expect(existsSync(join(ws, ".octobots", "pack-updates", "v58", "mission-execution", "local.md"))).toBe(true);
  });

  it("--pack-root replaces the pack only: a copy without a store still detects and reconciles against the extension's store", () => {
    const ws = forked();
    const root = mkdtempClean("qa-pack-");
    cpSync(PACK, root, { recursive: true });
    rmSync(join(root, "shipped-skills.json.br"), { force: true });
    expect(existsSync(join(root, "shipped-skills.json.br"))).toBe(false);
    const { status, report } = go([ws, "--pack-root", root]);
    expect(status).toBe(0);
    expect(report!.deviations).toEqual([expectedDeviation]);
    expect(report!.result.pending).toEqual(["mission-execution"]);
  });

  it.each([["--local-changes=merge"], ["--pack-version", "x"], ["--bogus"]])("exits 2 on a usage error: %s", (...bad) => {
    expect(go([forked(), ...bad]).status).toBe(2);
  });
});
