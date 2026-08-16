import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  installStatusline,
  registerStatusline,
  unregisterStatusline,
  statuslineStatus,
} from "../src/host/octobots-statusline.js";
import { resolveDoctorScript } from "../src/host/octobots-doctor-command.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");
const DOCTOR = join(PACK_SRC, "skill", "mission-planner", "scripts", "doctor.js");

const settingsOf = (repo: string) =>
  JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));

describe("status line install + registration", () => {
  it("installs the script and registers it through CLAUDE_PROJECT_DIR, never an absolute path", () => {
    const repo = mkdtempClean("octo-sl-");
    expect(installStatusline(PACK_SRC, repo)).toBe(1);
    expect(existsSync(join(repo, ".octobots", "statusline.sh"))).toBe(true);

    expect(registerStatusline(repo)).toBe("registered");
    const cmd: string = settingsOf(repo).statusLine.command;
    // Portability is the whole point: an absolute path breaks on another machine or a fresh clone.
    expect(cmd).toContain("${CLAUDE_PROJECT_DIR}");
    expect(cmd).not.toContain(repo);

    const st = statuslineStatus(repo, 54);
    expect(st.scriptPresent).toBe(true);
    expect(st.registered).toBe(true);
    expect(st.foreign).toBe(false);
  });

  it("refuses to overwrite somebody else's status line", () => {
    const repo = mkdtempClean("octo-sl-");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const theirs = { type: "command", command: "bash ~/.claude/my-own-statusline.sh" };
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ statusLine: theirs }));

    // `statusLine` holds ONE entry, so overwriting would delete a config we cannot restore.
    expect(registerStatusline(repo)).toBe("foreign");
    expect(settingsOf(repo).statusLine).toEqual(theirs);

    const st = statuslineStatus(repo, 54);
    expect(st.foreign).toBe(true);
    expect(st.registered).toBe(false);
  });

  it("unregister removes ours and leaves a foreign one alone", () => {
    const repo = mkdtempClean("octo-sl-");
    installStatusline(PACK_SRC, repo);
    registerStatusline(repo);
    expect(unregisterStatusline(repo)).toBe(true);
    expect(settingsOf(repo).statusLine).toBeUndefined();

    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ statusLine: { command: "theirs.sh" } }));
    expect(unregisterStatusline(repo)).toBe(false);
    expect(settingsOf(repo).statusLine.command).toBe("theirs.sh");
  });

  it("the shipped script runs, needs no TTY, and emits no stderr", () => {
    const payload = JSON.stringify({
      model: { display_name: "Claude Opus 5" },
      workspace: { current_dir: process.cwd() },
      context_window: { remaining_percentage: 72, context_window_size: 200000, total_input_tokens: 56000 },
    });
    // stderr must be clean: a status line that prints to stderr on every render is noise the user
    // cannot turn off from the UI.
    const out = execFileSync("bash", [join(PACK_SRC, "statusline", "statusline.sh")], {
      input: payload,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(out).toContain("Opus 5");
    expect(out).toContain("72% left");
  });
});

describe("doctor", () => {
  function doctor(repo: string, env: Record<string, string | undefined> = {}): { code: number; out: string } {
    try {
      const out = execFileSync("node", [DOCTOR, "--root", repo, "--json"], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  }

  it("FAILS when CLAUDE_CONFIG_DIR points outside the project", () => {
    const repo = mkdtempClean("octo-doc-");
    const { code, out } = doctor(repo, { CLAUDE_CONFIG_DIR: "/Users/somebody/.claude" });
    const report = JSON.parse(out);
    const f = report.findings.find((x: any) => x.area === "config-dir");
    expect(f.level).toBe("fail");
    expect(code).toBe(1);
  });

  it("WARNS when CLAUDE_CONFIG_DIR is unset — the ~/.claude default is shared by every project", () => {
    const repo = mkdtempClean("octo-doc-");
    const { out } = doctor(repo, { CLAUDE_CONFIG_DIR: undefined });
    const f = JSON.parse(out).findings.find((x: any) => x.area === "config-dir");
    expect(f.level).toBe("warn");
  });

  it("accepts a project-local CLAUDE_CONFIG_DIR", () => {
    const repo = mkdtempClean("octo-doc-");
    const { out } = doctor(repo, { CLAUDE_CONFIG_DIR: join(repo, ".claude") });
    const f = JSON.parse(out).findings.find((x: any) => x.area === "config-dir");
    expect(f.level).toBe("ok");
  });

  it("a sibling directory sharing the project's name prefix does not pass containment", () => {
    const repo = mkdtempClean("octo-doc-");
    const { out } = doctor(repo, { CLAUDE_CONFIG_DIR: `${repo}-evil/.claude` });
    const f = JSON.parse(out).findings.find((x: any) => x.area === "config-dir");
    expect(f.level).toBe("fail");
  });

  it("reports duplicate hook registrations, naming each one", () => {
    const repo = mkdtempClean("octo-doc-");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const primer = { hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.octobots/hooks/primer.mjs"' }] };
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [primer, primer], PostToolUse: [] },
    }));
    const { code, out } = doctor(repo, { CLAUDE_CONFIG_DIR: join(repo, ".claude") });
    const f = JSON.parse(out).findings.find((x: any) => x.area === "hooks");
    expect(f.level).toBe("fail");
    expect(f.msg).toContain("SessionStart:.octobots/hooks/primer.mjs x2");
    expect(code).toBe(1);
  });

  it("a single registration of each hook is not a duplicate", () => {
    const repo = mkdtempClean("octo-doc-");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: ".octobots/hooks/primer.mjs" }] }],
        PostToolUse: [
          { hooks: [{ type: "command", command: ".octobots/hooks/work-log.mjs" }] },
          { hooks: [{ type: "command", command: ".octobots/hooks/mission-gate.mjs" }] },
        ],
      },
    }));
    const { out } = doctor(repo, { CLAUDE_CONFIG_DIR: join(repo, ".claude") });
    const f = JSON.parse(out).findings.find((x: any) => x.area === "hooks");
    expect(f.level).toBe("ok");
  });

  it("flags a status line registered by absolute path", () => {
    const repo = mkdtempClean("octo-doc-");
    installStatusline(PACK_SRC, repo);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({
      statusLine: { type: "command", command: `bash /Users/somebody/.octobots/statusline.sh` },
    }));
    const { out } = doctor(repo, { CLAUDE_CONFIG_DIR: join(repo, ".claude") });
    const sl = JSON.parse(out).findings.filter((x: any) => x.area === "statusline");
    expect(sl.some((x: any) => x.level === "fail" && /ABSOLUTE path/.test(x.msg))).toBe(true);
  });

  it("prefers the workspace's installed doctor over the bundled one", () => {
    const repo = mkdtempClean("octo-doc-");
    // not installed → falls back to the bundled copy
    expect(resolveDoctorScript(repo, PACK_SRC)).toBe(DOCTOR);

    const installed = join(repo, ".claude", "skills", "mission-planner", "scripts", "doctor.js");
    mkdirSync(join(repo, ".claude", "skills", "mission-planner", "scripts"), { recursive: true });
    writeFileSync(installed, "// installed copy");
    expect(resolveDoctorScript(repo, PACK_SRC)).toBe(installed);
  });
});
