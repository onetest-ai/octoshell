import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(__dirname, "..", "resources", "octobots-pack", "hooks", "mission-gate.mjs");

function repoWithOctobots(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-gate-"));
  mkdirSync(join(dir, ".octobots"), { recursive: true });
  return dir;
}

function run(repo: string, title: string, state: string): string {
  return execFileSync("node", [GATE], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `node scripts/set-status.js mission.md "${title}" ${state}` },
    }),
    encoding: "utf8",
  });
}

describe("mission-gate.mjs", () => {
  it("injects the blocking gate directive when a MISSION flips to done", () => {
    const out = run(repoWithOctobots(), "M3 - Skills workspace", "done");
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/MISSION-COMPLETION GATE/);
    expect(ctx).toContain("M3 - Skills workspace");
    expect(ctx).toMatch(/mission-completion-gate/);
  });

  it("stays silent for a TASK — tasks gate inside mission-execution", () => {
    expect(run(repoWithOctobots(), "T3.2 - Add JWT validation", "done")).toBe("");
  });

  it("stays silent for a mission moving to any state other than done", () => {
    expect(run(repoWithOctobots(), "M3 - Skills workspace", "active")).toBe("");
  });

  it("is inert outside an Octobots repo", () => {
    const bare = mkdtempSync(join(tmpdir(), "octo-gate-bare-"));
    expect(run(bare, "M3 - Skills workspace", "done")).toBe("");
  });

  it("names the project's own mechanical gate, not a hard-coded build command", () => {
    const ctx = JSON.parse(run(repoWithOctobots(), "M1 - Anything", "done"))
      .hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toMatch(/make ci|make coverage/);
    expect(ctx).toMatch(/mechanical gate/);
  });
});
