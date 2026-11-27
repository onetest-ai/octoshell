import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { COMMIT_SHIM, PREPARE_SHIM, gitEnv, snapshotDir } from "./fixtures/hook-repo.js";

const INSTALL = fileURLToPath(new URL("../scripts/qa/install-pack.mjs", import.meta.url));

interface Report { result: { hooksRegistered: boolean }; after: { upToDate: boolean } }
const install = (ws: string, ...flags: string[]): Report =>
  JSON.parse(execFileSync(process.execPath, [INSTALL, ws, ...flags], { encoding: "utf8" })) as Report;
const doctor = (ws: string) => {
  const r = spawnSync(process.execPath, [join(ws, ".octobots", "hooks", "hooks-doctor.mjs"), "--root", ws], { encoding: "utf8", env: gitEnv(), cwd: ws });
  return { status: r.status, out: r.stdout + r.stderr };
};

/** A fresh repo copy: a git repo with its own committed hooks and no .claude/settings.json (it is gitignored). */
function freshCopy(opts: { shims: boolean }): string {
  const ws = mkdtempClean("install-hooks-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: ws, env: gitEnv(), encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const hooks = join(ws, ".githooks");
  mkdirSync(hooks);
  for (const [name, text] of [["pre-commit", "#!/bin/sh\n# own pre-commit\nexit 0\n"], ["pre-push", "#!/bin/sh\n# own pre-push\nexit 0\n"],
    ...(opts.shims ? [["prepare-commit-msg", PREPARE_SHIM], ["commit-msg", COMMIT_SHIM]] : [])] as [string, string][]) {
    writeFileSync(join(hooks, name), text);
    chmodSync(join(hooks, name), 0o755);
  }
  git("config", "core.hooksPath", ".githooks");
  return ws;
}

describe("install-pack.mjs --hooks", () => {
  it("registers exactly the three octoshell entries in a copy with no settings.json, and the doctor then exits 0", () => {
    const ws = freshCopy({ shims: true });
    expect(existsSync(join(ws, ".claude", "settings.json"))).toBe(false);
    const report = install(ws, "--hooks");
    expect(report.result.hooksRegistered).toBe(true);
    expect(report.after.upToDate).toBe(true);
    const settings = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf8"));
    const registered = Object.entries(settings.hooks as Record<string, { hooks: { command: string }[] }[]>)
      .flatMap(([event, entries]) => entries.flatMap((e) => e.hooks.map((h) => `${event} ${/\.octobots\/hooks\/([\w-]+\.mjs)/.exec(h.command)?.[1]}`)))
      .sort();
    expect(registered).toEqual([
      "PostToolUse work-log.mjs",
      "PreToolUse dispatch-on-main.mjs",
      "SessionStart primer.mjs",
    ]);
    const res = doctor(ws);
    expect(res.out).toContain("ok");
    expect(res.status).toBe(0);
  });

  it("without the flag the install writes no settings.json (hooks stay opt-in)", () => {
    const ws = freshCopy({ shims: true });
    expect(install(ws).result.hooksRegistered).toBe(false);
    expect(existsSync(join(ws, ".claude", "settings.json"))).toBe(false);
  });

  it("is idempotent: a second --hooks install leaves settings.json byte-identical", () => {
    const ws = freshCopy({ shims: true });
    install(ws, "--hooks");
    const first = readFileSync(join(ws, ".claude", "settings.json"), "utf8");
    install(ws, "--hooks");
    expect(readFileSync(join(ws, ".claude", "settings.json"), "utf8")).toBe(first);
  });

  it("the install ships the trailer script, the doctor and its default list under .octobots/hooks", () => {
    const ws = freshCopy({ shims: true });
    install(ws, "--hooks");
    for (const f of ["prepare-commit-msg.mjs", "hooks-doctor.mjs", "required-hooks.json"]) {
      expect(existsSync(join(ws, ".octobots", "hooks", f)), f).toBe(true);
    }
  });

  it("writes nothing under the repo's hooks directory; with no shim the doctor exits non-zero and prints the shim and config command", () => {
    const ws = freshCopy({ shims: false });
    const before = snapshotDir(join(ws, ".githooks"));
    install(ws, "--hooks");
    expect(snapshotDir(join(ws, ".githooks"))).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(["pre-commit", "pre-push"]);
    const res = doctor(ws);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(PREPARE_SHIM.trim());
    expect(res.out).toContain("git config core.hooksPath .githooks");
  });

  it("an install over an existing shim and own hooks leaves every file byte-identical", () => {
    const ws = freshCopy({ shims: true });
    const before = snapshotDir(join(ws, ".githooks"));
    install(ws, "--hooks");
    expect(snapshotDir(join(ws, ".githooks"))).toEqual(before);
  });
});
