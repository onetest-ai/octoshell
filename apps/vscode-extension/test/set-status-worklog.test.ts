import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { SET_STATUS, createBugNamed, installPlannerScripts, makeStatusBoard, postToolUseWithOutput } from "./fixtures/status-flip-board.js";
import { mkdirSync } from "node:fs";

const WORK_LOG = join(__dirname, "..", "resources", "octobots-pack", "hooks", "work-log.mjs");
const LOG = (repo: string) => join(repo, ".octobots", "tokenomics", "worklog.jsonl");
const lines = (repo: string): Record<string, unknown>[] =>
  existsSync(LOG(repo)) ? readFileSync(LOG(repo), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];

/** Run a shell command as the Bash tool would, with an optional Claude Code session id in the environment. */
function sh(repo: string, command: string, session?: string, extra: Record<string, string> = {}) {
  const { CLAUDE_CODE_SESSION_ID: _s, CLAUDE_PROJECT_DIR: _p, OCTOBOTS_PROJECT_DIR: _o, ...env } = process.env;
  return spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf8", env: { ...env, ...extra, ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}) } });
}
function hook(repo: string, payload: unknown): void {
  execFileSync("node", [WORK_LOG], { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, input: JSON.stringify(payload), encoding: "utf8" });
}
const gitInit = (repo: string) => execFileSync("git", ["init", "-q", "-b", "feat/demo-m1-t1"], { cwd: repo, encoding: "utf8" });

describe("set-status.js writes the work log line itself", () => {
  it("logs a task flip when the target and title come through shell variables", () => {
    const b = makeStatusBoard("ss-worklog-");
    gitInit(b.repo);
    const r = sh(b.repo, `D='${b.missionDir}'; T='T1.1 - Parse ids'; node "${SET_STATUS}" "$D" "$T" active`, "sess-var");
    expect(r.status, r.stderr).toBe(0);
    expect(lines(b.repo)).toHaveLength(1);
    expect(lines(b.repo)[0]).toMatchObject({ session_id: "sess-var", task: "T1.1", state: "active", branch: "feat/demo-m1-t1" });
    expect(typeof lines(b.repo)[0]!.at).toBe("string");
  });

  it("logs a mission flip as session -> mission", () => {
    const b = makeStatusBoard("ss-worklog-");
    const r = sh(b.repo, `P='${b.campaignDir}'; node "${SET_STATUS}" "$P" "M1 - Venue ingest" done`, "sess-m");
    expect(r.status, r.stderr).toBe(0);
    expect(lines(b.repo)[0]).toMatchObject({ session_id: "sess-m", mission: "M1", state: "done" });
  });

  it("logs nothing without a session id, and still succeeds", () => {
    const b = makeStatusBoard("ss-worklog-");
    const r = sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" active`);
    expect(r.status, r.stderr).toBe(0);
    expect(lines(b.repo)).toHaveLength(0);
  });

  it("logs nothing for a re-run that changed nothing, for a draft move, or for an entity that is neither task nor mission", () => {
    const b = makeStatusBoard("ss-worklog-");
    sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" active`, "s1");
    expect(lines(b.repo)).toHaveLength(1);
    sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" active`, "s1");
    expect(lines(b.repo)).toHaveLength(1);
    sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" draft`, "s1");
    expect(lines(b.repo)).toHaveLength(1);
    sh(b.repo, `node "${SET_STATUS}" "${b.campaignDir}" "C" done`, "s1");
    expect(lines(b.repo)).toHaveLength(1);
  });

  it("logs nothing when the target does not exist", () => {
    const b = makeStatusBoard("ss-worklog-");
    const r = sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T9.9 - no such task" active`, "s1");
    expect(r.status).toBe(1);
    expect(lines(b.repo)).toHaveLength(0);
  });

  it("the hook does not log the same flip a second time (same session, same target, same state)", () => {
    const b = makeStatusBoard("ss-worklog-");
    const command = `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" active`;
    const r = sh(b.repo, command, "sess-dup");
    hook(b.repo, postToolUseWithOutput(b.repo, command, r.stdout, "sess-dup"));
    expect(lines(b.repo)).toHaveLength(1);
  });

  it("the hook still records a flip set-status.js did not (no session id in its environment), and a later different state", () => {
    const b = makeStatusBoard("ss-worklog-");
    const start = `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" active`;
    hook(b.repo, postToolUseWithOutput(b.repo, start, sh(b.repo, start).stdout, "sess-h"));
    expect(lines(b.repo)).toHaveLength(1);
    const done = `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" done`;
    hook(b.repo, postToolUseWithOutput(b.repo, done, sh(b.repo, done, "sess-h").stdout, "sess-h"));
    expect(lines(b.repo).map((l) => `${l.task}:${l.state}`)).toEqual(["T1.1:active", "T1.1:done"]);
  });

  it("a second activation after done is a new line, not a duplicate", () => {
    const b = makeStatusBoard("ss-worklog-");
    const go = (state: string) => sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" ${state}`, "s1");
    go("active"); go("done"); go("active");
    expect(lines(b.repo).map((l) => l.state)).toEqual(["active", "done", "active"]);
  });
});

describe("a bug is never logged as the task or mission its title names", () => {
  // Bugs are often titled after where they were found ("T2.10 review nits", "M2 gate review nits").
  // Closing one must not log that task or mission done on the branch the sweep runs on.
  it("set-status.js writes no line for a mission bug titled like a task", () => {
    const b = makeStatusBoard("ss-worklog-bug-");
    createBugNamed(b, "T1.1 review nits");
    for (const state of ["active", "done"]) {
      const r = sh(b.repo, `node "${SET_STATUS}" "${b.missionDir}" "T1.1 review nits" ${state}`, "sess-bug");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("octobots: status bug");
    }
    expect(lines(b.repo)).toHaveLength(0);
  });

  it("set-status.js writes no line for a campaign bug titled like a mission", () => {
    const b = makeStatusBoard("ss-worklog-bug-");
    createBugNamed(b, "M1 gate review nits", "campaign");
    const r = sh(b.repo, `node "${SET_STATUS}" "${b.campaignDir}" "M1 gate review nits" done`, "sess-bug");
    expect(r.status, r.stderr).toBe(0);
    expect(lines(b.repo)).toHaveLength(0);
  });

  it("the hook writes no line for those bug flips either (set-status.js ran without a session id)", () => {
    const b = makeStatusBoard("ss-worklog-bug-");
    createBugNamed(b, "T1.1 review nits");
    createBugNamed(b, "M1 gate review nits", "campaign");
    const command =
      `node "${SET_STATUS}" "${b.missionDir}" "T1.1 review nits" done && ` +
      `node "${SET_STATUS}" "${b.campaignDir}" "M1 gate review nits" done`;
    const r = sh(b.repo, command);
    expect(r.status, r.stderr).toBe(0);
    hook(b.repo, postToolUseWithOutput(b.repo, command, r.stdout, "sess-bug-hook"));
    expect(lines(b.repo)).toHaveLength(0);
  });

  it("the hook still logs the real task in a chain that also closes a bug titled after it", () => {
    const b = makeStatusBoard("ss-worklog-bug-");
    createBugNamed(b, "T1.1 review nits");
    const command =
      `node "${SET_STATUS}" "${b.missionDir}" "T1.1 review nits" done && ` +
      `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" done`;
    const r = sh(b.repo, command);
    expect(r.status, r.stderr).toBe(0);
    hook(b.repo, postToolUseWithOutput(b.repo, command, r.stdout, "sess-bug-hook"));
    expect(lines(b.repo).map((l) => `${l.task}:${l.state}`)).toEqual(["T1.1:done"]);
  });
});

describe("one work-log file per flip, wherever the board lives", () => {
  it("a flip on a worktree board with CLAUDE_PROJECT_DIR elsewhere writes one line in one file (the session's project dir)", () => {
    const b = makeStatusBoard("ss-worklog-wt-");
    // The session's project dir (where the hook runs and the rollup reads) is a different checkout.
    const project = mkdtempClean("ss-worklog-proj-");
    mkdirSync(join(project, ".octobots"), { recursive: true });
    installPlannerScripts(project);
    const command = `node "${SET_STATUS}" "${b.missionDir}" "T1.1 - Parse ids" active`;
    const r = sh(b.repo, command, "sess-wt", { CLAUDE_PROJECT_DIR: project });
    expect(r.status, r.stderr).toBe(0);
    execFileSync("node", [WORK_LOG], {
      cwd: b.repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      input: JSON.stringify(postToolUseWithOutput(b.repo, command, r.stdout, "sess-wt")),
      encoding: "utf8",
    });
    expect(lines(project)).toHaveLength(1);
    expect(lines(project)[0]).toMatchObject({ session_id: "sess-wt", task: "T1.1", state: "active" });
    expect(existsSync(LOG(b.repo))).toBe(false);
  });
});
