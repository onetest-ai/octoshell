import { describe, it, expect } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { installPrimer, registerClaudeHook, unregisterClaudeHook, claudeHookStatus } from "../src/host/octobots-hooks.js";

const pack = join(__dirname, "../resources/octobots-pack");
function repo(branch: string) {
  const dir = mkdtempClean("dispatch-main-");
  execFileSync("git", ["init", "-b", branch, dir], { stdio: "ignore" });
  mkdirSync(join(dir, ".octobots"));
  return dir;
}
function run(dir: string, input: string) {
  return spawnSync("node", [join(pack, "hooks/dispatch-on-main.mjs")], {
    cwd: dir, input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}
const diagnostics = (dir: string) => join(dir, ".octobots/tokenomics/diagnostics.jsonl");

describe("warn-only dispatch diagnostics", () => {
  it("discards oversized valid input without recording a dispatch", () => {
    const dir = repo("main");
    const r = run(dir, JSON.stringify({ session_id: "s", tool_name: "Agent", cwd: dir, padding: "x".repeat(256 * 1024) }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(existsSync(diagnostics(dir))).toBe(false);
  });
  it.each(["{", " ".repeat(256 * 1024)])("exits silently with stdin left open (case %#)", async (input) => {
    const dir = repo("main");
    const child = spawn(process.execPath, [join(pack, "hooks/dispatch-on-main.mjs")], {
      cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => { /* The hook may close stdin before the oversized write completes. */ });
    const result = new Promise<number | null>((resolve) => child.on("close", resolve));
    const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
    try {
      child.stdin.write(input); // Deliberately never send EOF.
      expect(await result).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(existsSync(diagnostics(dir))).toBe(false);
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
    }
  });

  it.each([
    { PreToolUse: {} },
    { PreToolUse: [{ hooks: {} }] },
    { PreToolUse: [null, { hooks: [null] }] },
    { SessionStart: {} },
    { SessionStart: [{ hooks: {} }] },
  ])("doctor reports malformed hook arrays without crashing: %j", (hooks) => {
    const dir = repo("main");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }));
    const r = spawnSync(process.execPath, [join(pack, "skill/mission-planner/scripts/doctor.js"), "--root", dir, "--json"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout).findings).toContainEqual(expect.objectContaining({
      area: "hooks", level: "fail", msg: expect.stringMatching(/malformed/i),
    }));
  });
  it.each(["Agent", "Task"])("records exactly one %s dispatch on main without deciding", (tool_name) => {
    const dir = repo("main");
    const r = run(dir, JSON.stringify({ session_id: "session-main", tool_name, cwd: dir, tool_input: {} }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    const lines = readFileSync(diagnostics(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "dispatch-on-main", session_id: "session-main", branch: "main", tool_name });
  });
  it("uses the session cwd rather than a main checkout in the environment", () => {
    const main = repo("main"), feature = repo("feat/work");
    const r = run(main, JSON.stringify({ session_id: "s", tool_name: "Agent", cwd: feature }));
    expect(r.status).toBe(0);
    expect(existsSync(diagnostics(main))).toBe(false);
    expect(existsSync(diagnostics(feature))).toBe(false);
  });
  it.each(["feat/work", "master"])("does nothing on %s", (branch) => {
    const dir = repo(branch);
    expect(run(dir, JSON.stringify({ session_id: "s", tool_name: "Agent", cwd: dir })).status).toBe(0);
    expect(existsSync(diagnostics(dir))).toBe(false);
  });
  it.each(["{", "null", JSON.stringify({ tool_name: "Bash", session_id: "s" }), JSON.stringify({ tool_name: "Agent" })])("fails open on irrelevant or malformed input %s", (input) => {
    const dir = repo("main");
    const r = run(dir, input);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(diagnostics(dir))).toBe(false);
  });
  it("fails open when diagnostics cannot be written", () => {
    const dir = repo("main");
    writeFileSync(join(dir, ".octobots/tokenomics"), "not a directory");
    const r = run(dir, JSON.stringify({ session_id: "s", tool_name: "Agent", cwd: dir }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
  });
  it("doctor names the missing script by event until the installer runs", () => {
    const dir = repo("main");
    const doctor = () => {
      const r = spawnSync("node", [join(pack, "skill/mission-planner/scripts/doctor.js"), "--root", dir, "--json"], { encoding: "utf8" });
      return JSON.parse(r.stdout).findings.filter((f: { area: string }) => f.area === "hooks");
    };
    expect(doctor()).toContainEqual(expect.objectContaining({ level: "warn", msg: expect.stringContaining("PreToolUse"), fix: expect.stringContaining("Install Octobots Pack") }));
    expect(doctor()).toContainEqual(expect.objectContaining({ msg: expect.stringContaining(".octobots/hooks/dispatch-on-main.mjs") }));
    registerClaudeHook(dir, 999);
    const settingsPath = join(dir, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.hooks.PreToolUse[0].matcher = "Task|Agent";
    writeFileSync(settingsPath, JSON.stringify(settings));
    expect(doctor().some((f: { msg: string }) => f.msg.includes("missing"))).toBe(false);
  });
  it("installs, deduplicates, detects and unregisters PreToolUse Agent|Task by script path", () => {
    const dir = repo("main");
    installPrimer(pack, dir);
    expect(existsSync(join(dir, ".octobots/hooks/dispatch-on-main.mjs"))).toBe(true);
    registerClaudeHook(dir, 999);
    registerClaudeHook(dir, 999);
    const path = join(dir, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: "Agent|Task", hooks: [{ type: "command", command: expect.stringContaining(".octobots/hooks/dispatch-on-main.mjs") }] });
    expect(claudeHookStatus(dir, 999)).toEqual({ present: true, current: true });
    settings.hooks.PreToolUse[0].hooks[0].command = "unrelated";
    writeFileSync(path, JSON.stringify(settings));
    expect(claudeHookStatus(dir, 999).current).toBe(false);
    registerClaudeHook(dir, 999);
    unregisterClaudeHook(dir);
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse).toBeUndefined();
  });
});

it("finds the board for a main session launched from a repository subdirectory", () => {
  const dir = repo("main");
  const subdir = join(dir, "src"); mkdirSync(subdir);
  const r = run(dir, JSON.stringify({ session_id: "subdir", tool_name: "Agent", cwd: subdir }));
  expect(r.status).toBe(0);
  expect(JSON.parse(readFileSync(diagnostics(dir), "utf8").trim())).toMatchObject({ kind: "dispatch-on-main", session_id: "subdir" });
});
