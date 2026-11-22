import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerClaudeHook, OCTOBOTS_HOOK_SPECS, octoshellRequiredHooks } from "../src/host/octobots-hooks.js";
import { COMMIT_SHIM, PACK, PREPARE_SHIM, gitEnv, hookRepo, snapshotDir, type HookRepo } from "./fixtures/hook-repo.js";

const INSTALLER_COMMAND = 'VS Code command palette: "Octobots: Install Octobots Pack" (current Octobots extension)';

function doctor(r: HookRepo, ...extra: string[]) {
  const res = spawnSync(process.execPath, [join(r.root, ".octobots", "hooks", "hooks-doctor.mjs"), "--root", r.root, ...extra], {
    encoding: "utf8", env: gitEnv(), cwd: r.root,
  });
  return { status: res.status, out: res.stdout + res.stderr };
}
const settingsPath = (r: HookRepo) => join(r.root, ".claude", "settings.json");
const readSettings = (r: HookRepo) => JSON.parse(readFileSync(settingsPath(r), "utf8"));

describe("the pack's default required list", () => {
  it("is derived from the installer's own list: the shipped file equals octoshellRequiredHooks()", () => {
    const shipped = JSON.parse(readFileSync(join(PACK, "hooks", "required-hooks.json"), "utf8"));
    expect(shipped).toEqual(octoshellRequiredHooks());
    expect(shipped.hooks.map((h: { script: string }) => h.script)).toEqual(OCTOBOTS_HOOK_SPECS.map((s) => s.script));
    expect(shipped.installers.octoshell.command).toBe(INSTALLER_COMMAND);
  });

  it("lists the four octoshell entries and nothing else", () => {
    const shipped = JSON.parse(readFileSync(join(PACK, "hooks", "required-hooks.json"), "utf8"));
    expect(shipped.hooks.map((h: { event: string; script: string }) => `${h.event} ${h.script}`)).toEqual([
      "SessionStart .octobots/hooks/primer.mjs",
      "PostToolUse .octobots/hooks/work-log.mjs",
      "PostToolUse .octobots/hooks/mission-gate.mjs",
      "PreToolUse .octobots/hooks/dispatch-on-main.mjs",
    ]);
  });
});

describe("hooks-doctor: settings.json side", () => {
  it("exits 0 for installer-produced settings and a correct shim", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    const res = doctor(r);
    expect(res.out).toContain("ok");
    expect(res.status).toBe(0);
  });

  it("a missing octoshell hook script names path, event, owning installer and exact command, and exits non-zero", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    const s = readSettings(r);
    s.hooks.PostToolUse = s.hooks.PostToolUse.filter((e: { hooks: { command: string }[] }) => !e.hooks[0]!.command.includes("mission-gate.mjs"));
    writeFileSync(settingsPath(r), JSON.stringify(s, null, 2));
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/MISSING\s+PostToolUse\s+\.octobots\/hooks\/mission-gate\.mjs/);
    expect(res.out).toContain("owner: octoshell");
    expect(res.out).toContain(INSTALLER_COMMAND);
    expect(res.out).not.toMatch(/MISSING\s+\w+\s+\.octobots\/hooks\/(primer|work-log|dispatch-on-main)/);
  });

  it("an absent settings.json reports every entry missing, exits 1, and is not created", () => {
    const r = hookRepo();
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out.match(/MISSING/g)).toHaveLength(4);
    expect(existsSync(settingsPath(r))).toBe(false);
  });

  it("the matcher counts: dispatch-on-main registered under Bash is not wired", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    const s = readSettings(r);
    s.hooks.PreToolUse[0].matcher = "Bash";
    writeFileSync(settingsPath(r), JSON.stringify(s));
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/MISSING\s+PreToolUse\s+\.octobots\/hooks\/dispatch-on-main\.mjs/);
  });

  it("a hooks value that is not an array is a clean message, not a stack trace", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    const s = readSettings(r);
    s.hooks.PostToolUse = { not: "an array" };
    writeFileSync(settingsPath(r), JSON.stringify(s));
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).not.toMatch(/TypeError|node:internal|\n\s+at /);
    expect(res.out).toMatch(/PostToolUse/);
  });

  it("invalid JSON exits 2 without a stack trace", () => {
    const r = hookRepo();
    mkdirSync(join(r.root, ".claude"), { recursive: true });
    writeFileSync(settingsPath(r), "{ nope");
    const res = doctor(r);
    expect(res.status).toBe(2);
    expect(res.out).not.toMatch(/node:internal|\n\s+at /);
  });

  it("never writes settings.json: the bytes and mtime survive a failing run", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    const s = readSettings(r);
    s.hooks.SessionStart = [];
    writeFileSync(settingsPath(r), JSON.stringify(s));
    const before = [readFileSync(settingsPath(r), "utf8"), statSync(settingsPath(r)).mtimeMs];
    expect(doctor(r).status).toBe(1);
    expect([readFileSync(settingsPath(r), "utf8"), statSync(settingsPath(r)).mtimeMs]).toEqual(before);
  });
});

describe("hooks-doctor: repo override list", () => {
  const override = (r: HookRepo, hooks: unknown[], installers: Record<string, unknown> = {}) => {
    mkdirSync(join(r.root, ".agents", "settings"), { recursive: true });
    writeFileSync(
      join(r.root, ".agents", "settings", "required-hooks.json"),
      JSON.stringify({ version: 1, installers: { "delivery-monitor": { source: "sdlc-skills", command: "node install-hooks.mjs" }, ...installers }, hooks }),
    );
  };

  it("adds an entry to the default: missing until wired, matched by script and arg, never by absolute path", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    override(r, [{ event: "SubagentStop", script: ".claude/skills/delivery-monitor/hooks/dispatch-hook.mjs", owner: "delivery-monitor" }]);
    let res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/MISSING\s+SubagentStop\s+\.claude\/skills\/delivery-monitor\/hooks\/dispatch-hook\.mjs/);
    expect(res.out).toContain("node install-hooks.mjs");
    const s = readSettings(r);
    s.hooks.SubagentStop = [{ hooks: [{ type: "command", command: 'node "/some/other/checkout/.claude/skills/delivery-monitor/hooks/dispatch-hook.mjs"' }] }];
    writeFileSync(settingsPath(r), JSON.stringify(s));
    res = doctor(r);
    expect(res.status).toBe(0);
  });

  it("keys a launcher entry by its verb argument", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    override(r, [{ event: "PreToolUse", script: ".claude/hooks/sdlc-skills/run-hook.cmd", arg: "agent-brief", owner: "delivery-monitor" }]);
    const s = readSettings(r);
    s.hooks.PreToolUse.push({ hooks: [{ type: "command", command: '"${CLAUDE_PROJECT_DIR}/.claude/hooks/sdlc-skills/run-hook.cmd" other-verb' }] });
    writeFileSync(settingsPath(r), JSON.stringify(s));
    expect(doctor(r).status).toBe(1);
    s.hooks.PreToolUse.push({ hooks: [{ type: "command", command: '"${CLAUDE_PROJECT_DIR}/.claude/hooks/sdlc-skills/run-hook.cmd" agent-brief' }] });
    writeFileSync(settingsPath(r), JSON.stringify(s));
    expect(doctor(r).status).toBe(0);
  });

  it("is add-only: an override that repeats a default entry cannot remove or relax it", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    override(r, [{ event: "PostToolUse", script: ".octobots/hooks/work-log.mjs", owner: "delivery-monitor" }]);
    const s = readSettings(r);
    s.hooks.PostToolUse = s.hooks.PostToolUse.filter((e: { hooks: { command: string }[] }) => !e.hooks[0]!.command.includes("work-log.mjs"));
    writeFileSync(settingsPath(r), JSON.stringify(s));
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/MISSING\s+PostToolUse\s+\.octobots\/hooks\/work-log\.mjs/);
    expect(res.out).toContain(INSTALLER_COMMAND);
    expect(res.out.match(/MISSING/g)).toHaveLength(1);
  });

  it("an unreadable override is exit 2, not a silent fallback to the default", () => {
    const r = hookRepo();
    registerClaudeHook(r.root, 59);
    mkdirSync(join(r.root, ".agents", "settings"), { recursive: true });
    writeFileSync(join(r.root, ".agents", "settings", "required-hooks.json"), "{ nope");
    expect(doctor(r).status).toBe(2);
  });
});

describe("hooks-doctor: git side", () => {
  const withSettings = (r: HookRepo) => registerClaudeHook(r.root, 59);

  it("with no shim, exits non-zero and prints both shim texts and the git config command", () => {
    const r = hookRepo("hook-repo-", { shims: false });
    withSettings(r);
    const before = snapshotDir(join(r.root, ".githooks"));
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toContain(".githooks/prepare-commit-msg");
    expect(res.out).toContain(".githooks/commit-msg");
    expect(res.out).toContain(PREPARE_SHIM.trim());
    expect(res.out).toContain(COMMIT_SHIM.trim());
    expect(res.out).toContain("git config core.hooksPath .githooks");
    expect(snapshotDir(join(r.root, ".githooks"))).toEqual(before);
  });

  it("with core.hooksPath unset, names that cause and prints the git config command", () => {
    const r = hookRepo();
    withSettings(r);
    r.git("config", "--unset", "core.hooksPath");
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/core\.hooksPath is not set/);
    expect(res.out).toContain("git config core.hooksPath .githooks");
  });

  it("a shim without the exec bit is named", () => {
    const r = hookRepo();
    withSettings(r);
    chmodSync(join(r.root, ".githooks", "commit-msg"), 0o644);
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/commit-msg.*not executable/);
    expect(res.out).not.toMatch(/prepare-commit-msg.*not executable/);
  });

  it("a shim that does not call the pack script is named", () => {
    const r = hookRepo();
    withSettings(r);
    writeFileSync(join(r.root, ".githooks", "prepare-commit-msg"), "#!/bin/sh\nexit 0\n");
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/prepare-commit-msg.*does not run \.octobots\/hooks\/prepare-commit-msg\.mjs/);
  });

  for (const [name, text, why] of [
    ["commit-msg", PREPARE_SHIM, /commit-msg.*--after-edit/],
    ["prepare-commit-msg", COMMIT_SHIM, /prepare-commit-msg.*--after-edit/],
  ] as const) {
    it(`a ${name} shim with the other entry point's text is named (review round 1)`, () => {
      const r = hookRepo();
      withSettings(r);
      writeFileSync(join(r.root, ".githooks", name), text);
      const res = doctor(r);
      expect(res.status).toBe(1);
      expect(res.out).toMatch(why);
    });
  }

  it("honours a core.hooksPath other than .githooks", () => {
    const r = hookRepo("hook-repo-", { shims: false });
    withSettings(r);
    r.git("config", "core.hooksPath", "tools/hooks");
    const res = doctor(r);
    expect(res.status).toBe(1);
    expect(res.out).toContain("tools/hooks/prepare-commit-msg");
    rmSync(join(r.root, "tools"), { recursive: true, force: true });
  });

  it("--no-git skips the git side", () => {
    const r = hookRepo("hook-repo-", { shims: false });
    withSettings(r);
    expect(doctor(r, "--no-git").status).toBe(0);
  });
});
