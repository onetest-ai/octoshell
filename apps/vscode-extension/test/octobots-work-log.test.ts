import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { makeStatusBoard, postToolUse, runAndPost, setStatusCommand } from "./fixtures/status-flip-board.js";

const WORK_LOG = join(__dirname, "..", "resources", "octobots-pack", "hooks", "work-log.mjs");
const LOG = (repo: string) => join(repo, ".octobots", "tokenomics", "worklog.jsonl");

/** Drive the hook the way Claude Code does: PostToolUse payload on stdin. */
function run(repo: string, payload: unknown): string {
  return execFileSync("node", [WORK_LOG], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function entries(repo: string): Record<string, unknown>[] {
  if (!existsSync(LOG(repo))) return [];
  return readFileSync(LOG(repo), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("work-log.mjs", () => {
  it("records a task status flip as session -> task", () => {
    const b = makeStatusBoard("octo-worklog-");
    run(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T1.1 - Parse ids", "active")));
    expect(entries(b.repo)).toHaveLength(1);
    expect(entries(b.repo)[0]).toMatchObject({ session_id: "sess-abc", task: "T1.1", state: "active" });
  });

  it("records a mission status flip as session -> mission", () => {
    const b = makeStatusBoard("octo-worklog-");
    run(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done")));
    expect(entries(b.repo)[0]).toMatchObject({ session_id: "sess-abc", mission: "M1", state: "done" });
  });

  it("appends, so a session touching a task twice is fully recorded", () => {
    const b = makeStatusBoard("octo-worklog-");
    run(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T1.1 - Parse ids", "active")));
    run(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T1.1 - Parse ids", "done")));
    expect(entries(b.repo).map((e) => `${e.task}:${e.state}`)).toEqual(["T1.1:active", "T1.1:done"]);
  });

  it("emits nothing on stdout — it must never steer the agent", () => {
    const b = makeStatusBoard("octo-worklog-");
    expect(run(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T1.1 - Parse ids", "active")))).toBe("");
  });

  it("ignores Bash calls that are not a status flip", () => {
    const b = makeStatusBoard("octo-worklog-");
    run(b.repo, { tool_name: "Bash", session_id: "s", tool_input: { command: "git status" } });
    expect(entries(b.repo)).toHaveLength(0);
  });

  it("ignores non-Bash tools", () => {
    const b = makeStatusBoard("octo-worklog-");
    run(b.repo, { tool_name: "Read", session_id: "s", tool_input: { file_path: "x" } });
    expect(entries(b.repo)).toHaveLength(0);
  });

  it("ignores states other than active/done, and titles that are neither a task nor a mission", () => {
    const b = makeStatusBoard("octo-worklog-");
    run(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T1.1 - Parse ids", "draft")));
    run(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "C", "done")));
    expect(entries(b.repo)).toHaveLength(0);
  });

  it("is inert outside an Octobots repo", () => {
    const bare = mkdtempClean("octo-bare-"); // no .octobots/
    mkdirSync(join(bare, "x"));
    run(bare, postToolUse(bare, setStatusCommand(join(bare, "x"), "T1.1 - Anything", "active")));
    expect(existsSync(LOG(bare))).toBe(false);
  });

  it("survives a malformed payload without failing the tool call", () => {
    const b = makeStatusBoard("octo-worklog-");
    expect(() =>
      execFileSync("node", [WORK_LOG], {
        cwd: b.repo,
        env: { ...process.env, CLAUDE_PROJECT_DIR: b.repo },
        input: "not json",
        encoding: "utf8",
      }),
    ).not.toThrow();
  });

  describe("logs only a flip that landed (mission AC8)", () => {
    it("writes nothing when set-status.js found no such mission, although the shell exit was 0", () => {
      const b = makeStatusBoard("octo-worklog-");
      const out = run(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M9 - no such mission", "done", "; echo")));
      expect(out).toBe("");
      expect(entries(b.repo)).toHaveLength(0);
    });

    it("writes nothing for a start that was refused (no such task), so no session is attributed", () => {
      const b = makeStatusBoard("octo-worklog-");
      run(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T9.9 - no such task", "active", "; echo")));
      expect(entries(b.repo)).toHaveLength(0);
    });

    it("still logs an existing mission whose YAML changed, under the same '; echo' tail", () => {
      const b = makeStatusBoard("octo-worklog-");
      run(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done", "; echo")));
      expect(entries(b.repo)).toHaveLength(1);
      expect(entries(b.repo)[0]).toMatchObject({ mission: "M1", state: "done" });
    });

    it("writes nothing when the command never ran, so the YAML does not hold the state", () => {
      const b = makeStatusBoard("octo-worklog-");
      run(b.repo, postToolUse(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done")));
      expect(entries(b.repo)).toHaveLength(0);
    });

    it("writes nothing when the script cannot be located to verify against (fail closed)", () => {
      const b = makeStatusBoard("octo-worklog-");
      run(b.repo, postToolUse(b.repo, `node scripts/set-status.js "${b.campaignDir}" "M1 - Venue ingest" done`));
      expect(entries(b.repo)).toHaveLength(0);
    });
  });
});
