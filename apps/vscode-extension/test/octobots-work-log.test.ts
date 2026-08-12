import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const WORK_LOG = join(__dirname, "..", "resources", "octobots-pack", "hooks", "work-log.mjs");
const LOG = (repo: string) => join(repo, ".octobots", "tokenomics", "worklog.jsonl");

function repoWithOctobots(): string {
  const dir = mkdtempClean("octo-worklog-");
  mkdirSync(join(dir, ".octobots"), { recursive: true });
  return dir;
}

/** Drive the hook the way Claude Code does: PostToolUse payload on stdin. */
function run(repo: string, payload: unknown): string {
  return execFileSync("node", [WORK_LOG], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

const setStatus = (title: string, state: string) => ({
  tool_name: "Bash",
  session_id: "sess-abc",
  tool_input: {
    command: `node .claude/skills/mission-planner/scripts/set-status.js mission.md "${title}" ${state}`,
  },
});

function entries(repo: string): Record<string, unknown>[] {
  if (!existsSync(LOG(repo))) return [];
  return readFileSync(LOG(repo), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("work-log.mjs", () => {
  it("records a task status flip as session -> task", () => {
    const repo = repoWithOctobots();
    run(repo, setStatus("T3.2 - Add JWT validation", "active"));
    expect(entries(repo)).toHaveLength(1);
    expect(entries(repo)[0]).toMatchObject({ session_id: "sess-abc", task: "T3.2", state: "active" });
  });

  it("records a mission status flip as session -> mission", () => {
    const repo = repoWithOctobots();
    run(repo, setStatus("M3 - Skills workspace", "done"));
    expect(entries(repo)[0]).toMatchObject({ session_id: "sess-abc", mission: "M3", state: "done" });
  });

  it("appends, so a session touching several tasks is fully recorded", () => {
    const repo = repoWithOctobots();
    run(repo, setStatus("T3.1 - First", "active"));
    run(repo, setStatus("T3.1 - First", "done"));
    run(repo, setStatus("T3.2 - Second", "active"));
    expect(entries(repo).map((e) => `${e.task}:${e.state}`)).toEqual([
      "T3.1:active",
      "T3.1:done",
      "T3.2:active",
    ]);
  });

  it("emits nothing on stdout — it must never steer the agent", () => {
    const repo = repoWithOctobots();
    expect(run(repo, setStatus("T1.1 - Anything", "active"))).toBe("");
  });

  it("ignores Bash calls that are not a status flip", () => {
    const repo = repoWithOctobots();
    run(repo, { tool_name: "Bash", session_id: "s", tool_input: { command: "git status" } });
    expect(entries(repo)).toHaveLength(0);
  });

  it("ignores non-Bash tools", () => {
    const repo = repoWithOctobots();
    run(repo, { tool_name: "Read", session_id: "s", tool_input: { file_path: "x" } });
    expect(entries(repo)).toHaveLength(0);
  });

  it("ignores states other than active/done, and campaign/bug titles", () => {
    const repo = repoWithOctobots();
    run(repo, setStatus("T3.2 - Add JWT validation", "draft"));
    run(repo, setStatus("Some bug title", "done"));
    expect(entries(repo)).toHaveLength(0);
  });

  it("is inert outside an Octobots repo", () => {
    const bare = mkdtempClean("octo-bare-"); // no .octobots/
    run(bare, setStatus("T1.1 - Anything", "active"));
    expect(existsSync(LOG(bare))).toBe(false);
  });

  it("survives a malformed payload without failing the tool call", () => {
    const repo = repoWithOctobots();
    expect(() =>
      execFileSync("node", [WORK_LOG], {
        cwd: repo,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
        input: "not json",
        encoding: "utf8",
      }),
    ).not.toThrow();
  });
});
