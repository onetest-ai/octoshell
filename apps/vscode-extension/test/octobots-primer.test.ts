import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIMER = join(__dirname, "..", "resources", "octobots-pack", "hooks", "primer.mjs");

function run(backend: string, cwd: string, event = "SessionStart"): string {
  return execFileSync("node", [PRIMER, "--backend", backend], {
    cwd,
    input: JSON.stringify({ hook_event_name: event }),
    encoding: "utf8",
  });
}

function repoWithOctobots(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-repo-"));
  mkdirSync(join(dir, ".octobots"), { recursive: true });
  return dir;
}

describe("primer.mjs", () => {
  it("emits Claude/Codex hookSpecificOutput JSON with the primer when .octobots exists", () => {
    const out = run("claude", repoWithOctobots());
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Octobots");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/file bugs on the board/i);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/Epic\/Story\/Task/i);
  });

  it("uses the calling event name in hookEventName", () => {
    const out = run("codex", repoWithOctobots(), "PreCompact");
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PreCompact");
  });

  it("emits Copilot additionalContext shape", () => {
    const out = run("copilot", repoWithOctobots());
    const parsed = JSON.parse(out);
    expect(parsed.additionalContext).toContain("Octobots");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("emits NOTHING when there is no .octobots directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-repo-"));
    expect(run("claude", dir).trim()).toBe("");
  });
});
