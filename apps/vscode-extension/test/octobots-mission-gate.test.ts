import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { SET_STATUS, makeStatusBoard, postToolUse, runAndPost, setStatusCommand } from "./fixtures/status-flip-board.js";

const GATE = join(__dirname, "..", "resources", "octobots-pack", "hooks", "mission-gate.mjs");

/** Pipe a PostToolUse payload into the hook the way Claude Code does; return its stdout. */
function pipe(repo: string, payload: unknown): string {
  return execFileSync("node", [GATE], {
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

const directiveOf = (out: string): string => JSON.parse(out).hookSpecificOutput.additionalContext as string;

describe("mission-gate.mjs", () => {
  it("injects the blocking gate directive when a MISSION really flips to done", () => {
    const b = makeStatusBoard("octo-gate-");
    const out = pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done")));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/MISSION-COMPLETION GATE/);
    expect(ctx).toContain("M1 - Venue ingest");
    expect(ctx).toMatch(/mission-completion-gate/);
  });

  it("uses relay wording for the Rio-to-devs challenge and never says 'directly' (mission AC7)", () => {
    const b = makeStatusBoard("octo-gate-");
    const ctx = directiveOf(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done"))));
    expect(ctx).toMatch(/relay/i);
    expect(ctx).not.toMatch(/directly/i);
  });

  it("matches the skill's phases 1-3: dispatched sub-agents, black-box QA, review that blocks on stillOpen only", () => {
    const b = makeStatusBoard("octo-gate-");
    const ctx = directiveOf(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done"))));
    expect(ctx).toMatch(/`Agent` tool/);
    expect(ctx).toMatch(/Tests \+ coverage/);
    expect(ctx).toMatch(/BLACK-BOX/);
    expect(ctx).toMatch(/never the\s+diff or the code/);
    expect(ctx).toMatch(/Critical review \(Rio\)/);
    expect(ctx).toMatch(/questions_for_devs/);
    expect(ctx).toMatch(/stillOpen/);
    expect(ctx).toMatch(/one review round and one\s+fix round/i);
    expect(ctx).toMatch(/board\s+bugs/);
    expect(ctx).toMatch(/Tokenomics/);
  });

  it("names the project's own mechanical gate, not a hard-coded build command", () => {
    const b = makeStatusBoard("octo-gate-");
    const ctx = directiveOf(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done"))));
    expect(ctx).not.toMatch(/make ci|make coverage|make \w+-test/);
    expect(ctx).toMatch(/mechanical gate/);
  });

  it("stays silent for a TASK — tasks gate inside mission-execution", () => {
    const b = makeStatusBoard("octo-gate-");
    expect(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.missionDir, "T1.1 - Parse ids", "done")))).toBe("");
  });

  it("stays silent for a mission moving to any state other than done", () => {
    const b = makeStatusBoard("octo-gate-");
    expect(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "active")))).toBe("");
  });

  it("is inert outside an Octobots repo", () => {
    const bare = mkdtempClean("octo-gate-bare-");
    mkdirSync(join(bare, "x"));
    expect(pipe(bare, postToolUse(bare, setStatusCommand(join(bare, "x"), "M1 - Venue ingest", "done")))).toBe("");
  });

  describe("acts only when the board now holds the requested status (mission AC8)", () => {
    it("stays silent when set-status.js found no such mission, even though the shell exit was 0", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M9 - no such mission", "done", "; echo");
      expect(pipe(b.repo, runAndPost(b.repo, cmd))).toBe("");
    });

    it("still acts for an existing mission whose YAML changed, under the same '; echo' tail", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done", "; echo");
      expect(directiveOf(pipe(b.repo, runAndPost(b.repo, cmd)))).toContain("M1 - Venue ingest");
    });

    it("stays silent when the command was never run, so the mission is not done on disk", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      expect(pipe(b.repo, postToolUse(b.repo, cmd))).toBe("");
    });

    it("stays silent when set-status.js rejected the state (a bogus state leaves the YAML alone)", () => {
      const b = makeStatusBoard("octo-gate-");
      expect(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "bogus", "; echo")))).toBe("");
    });

    it("resolves a relative <parent-dir> against the payload's cwd, the way the shell did", () => {
      const b = makeStatusBoard("octo-gate-");
      const rel = b.campaignDir.slice(b.repo.length + 1);
      const cmd = `node "${SET_STATUS}" "${rel}" "M1 - Venue ingest" done`;
      expect(directiveOf(pipe(b.repo, runAndPost(b.repo, cmd)))).toContain("M1 - Venue ingest");
    });

    it("stays silent when the script cannot be located to verify against (fail closed)", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = `node scripts/set-status.js "${b.campaignDir}" "M1 - Venue ingest" done`;
      expect(pipe(b.repo, postToolUse(b.repo, cmd))).toBe("");
    });
  });
});
