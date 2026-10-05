import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { SET_STATUS, createMissionNamed, makeStatusBoard, postToolUse, postToolUseWithOutput, runAndPost, setStatusCommand } from "./fixtures/status-flip-board.js";

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

    it("stays silent when the pack's resolver is not installed in the project (fail closed)", () => {
      const b = makeStatusBoard("octo-gate-", { install: false });
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      expect(pipe(b.repo, runAndPost(b.repo, cmd))).toBe("");
    });
  });


  describe("acts only on a REAL transition, not when the status merely equals the request (B3)", () => {
    const FORGED = 'octobots: status mission "M1 - Venue ingest" draft -> done';

    it("(a) acts on the first done", () => {
      const b = makeStatusBoard("octo-gate-");
      expect(directiveOf(pipe(b.repo, runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done"))))).toContain("M1 - Venue ingest");
    });

    it("(b) is silent when done is re-run on an already-done mission", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      expect(pipe(b.repo, runAndPost(b.repo, cmd))).not.toBe("");
      const again = runAndPost(b.repo, cmd);
      expect((again.tool_response as { stdout: string }).stdout).toContain("unchanged");
      expect(pipe(b.repo, again)).toBe("");
    });

    it("(c) in a chain, acts only for the call that changed", () => {
      const b = makeStatusBoard("octo-gate-");
      createMissionNamed(b, "M2 - Second");
      runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done")); // M1 already done
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done") + " && " + setStatusCommand(b.campaignDir, "M2 - Second", "done");
      const ctx = directiveOf(pipe(b.repo, runAndPost(b.repo, cmd)));
      expect(ctx).toContain('"M2 - Second"');
      expect(ctx).not.toContain("M1 - Venue ingest");
    });

    it("(d) a forged echo of the transition line is silent while the YAML is unchanged", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = `echo '${FORGED}'; ` + setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      expect(pipe(b.repo, postToolUseWithOutput(b.repo, cmd, FORGED + "\n"))).toBe("");
    });

    it("(d2) a forged echo is silent even after the mission was already done (no real transition)", () => {
      const b = makeStatusBoard("octo-gate-");
      runAndPost(b.repo, setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done"));
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      const forged = postToolUseWithOutput(b.repo, cmd, "unchanged\n");
      expect(pipe(b.repo, forged)).toBe("");
    });

    it("(e) is silent when tool_response is absent (fail closed), even though the YAML says done", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      runAndPost(b.repo, cmd);
      expect(pipe(b.repo, postToolUse(b.repo, cmd))).toBe("");
    });

    it("acts on a real transition from a hand-written non-canonical status (`awaiting approval` -> done)", () => {
      const b = makeStatusBoard("octo-gate-");
      const file = join(b.campaignDir, "missions", readdirSync(join(b.campaignDir, "missions"))[0]!, "mission.yaml");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^status:.*$/m, "status: awaiting approval"), "utf8");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      expect(directiveOf(pipe(b.repo, runAndPost(b.repo, cmd)))).toContain("M1 - Venue ingest");
    });

    it("parses a transition line whose before-state contains a space (an older set-status.js)", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      runAndPost(b.repo, cmd); // the YAML now holds done
      const line = 'octobots: status mission "M1 - Venue ingest" awaiting approval -> done';
      expect(directiveOf(pipe(b.repo, postToolUseWithOutput(b.repo, cmd, line)))).toContain("M1 - Venue ingest");
    });

    it("reads a plain-string tool_response too", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd = setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      const real = runAndPost(b.repo, cmd);
      const payload = { ...real, tool_response: (real.tool_response as { stdout: string }).stdout };
      expect(directiveOf(pipe(b.repo, payload))).toContain("M1 - Venue ingest");
    });
  });

  describe("security: entity-io.mjs comes from the installed pack only, never from the command", () => {
    /** A planted `<dir>/entity-io.mjs` that drops a marker file the moment anything imports it. */
    function plant(repo: string): { dir: string; marker: string } {
      const dir = join(repo, "evil");
      mkdirSync(dir);
      const marker = join(repo, "PWNED");
      writeFileSync(
        join(dir, "entity-io.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n` +
          "export const mapBoardStatus = () => \"done\";\nexport const resolveStatusTarget = () => ({ dir: '/', kind: 'mission' });\n" +
          "export const resolveEntityFile = () => ({ file: '/', format: 'yaml' });\nexport const readEntity = () => ({ status: 'done' });\n",
      );
      return { dir, marker };
    }

    it("never imports an entity-io.mjs beside a set-status.js path the command merely names", () => {
      const b = makeStatusBoard("octo-gate-");
      const { dir, marker } = plant(b.repo);
      // The shell runs nothing but `echo`; before the fix the hook imported evil/entity-io.mjs.
      const cmd = `echo ${dir}/set-status.js "${b.campaignDir}" "M1 - Venue ingest" done`;
      expect(pipe(b.repo, postToolUse(b.repo, cmd))).toBe("");
      expect(existsSync(marker)).toBe(false);
    });

    it("confirms through the installed resolver even when the command ran a set-status.js elsewhere", () => {
      const b = makeStatusBoard("octo-gate-");
      const { dir, marker } = plant(b.repo);
      const real = spawnSync("sh", ["-c", setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done")], { cwd: b.repo, encoding: "utf8" });
      const cmd = `node ${dir}/set-status.js "${b.campaignDir}" "M1 - Venue ingest" done`;
      expect(directiveOf(pipe(b.repo, postToolUseWithOutput(b.repo, cmd, real.stdout)))).toContain("M1 - Venue ingest");
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe("command parsing", () => {
    it("gates a mission flipped after a task in the same chained command", () => {
      const b = makeStatusBoard("octo-gate-");
      const cmd =
        setStatusCommand(b.missionDir, "T1.1 - Parse ids", "done") + " && " + setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done");
      expect(directiveOf(pipe(b.repo, runAndPost(b.repo, cmd)))).toContain('"M1 - Venue ingest"');
    });

    it("reads past `2>&1 | tail`, a `--force=…` flag, and a board path containing spaces", () => {
      const b = makeStatusBoard("octo gate spaced ");
      const cmd = `node "${SET_STATUS}" --force=reason "${b.campaignDir}" "M1 - Venue ingest" done 2>&1 | tail -1`;
      // set-status.js does not take --force yet (M5): flip for real, then post the flagged command.
      const real = spawnSync("sh", ["-c", setStatusCommand(b.campaignDir, "M1 - Venue ingest", "done")], { cwd: b.repo, encoding: "utf8" });
      expect(directiveOf(pipe(b.repo, postToolUseWithOutput(b.repo, cmd, real.stdout)))).toContain("M1 - Venue ingest");
    });

    it("keeps a quoted title containing ; && \" and ' as one argument", () => {
      const b = makeStatusBoard("octo-gate-");
      const title = `M2 - a; b && say "hi" it's`;
      createMissionNamed(b, title);
      const cmd = `node "${SET_STATUS}" "${b.campaignDir}" 'M2 - a; b && say "hi" it'"'"'s' done`;
      expect(directiveOf(pipe(b.repo, runAndPost(b.repo, cmd)))).toContain(title);
    });

    it("never throws or prints a stack for a null payload or a non-string command", () => {
      const b = makeStatusBoard("octo-gate-");
      for (const input of ["null", "42", JSON.stringify({ tool_name: "Bash", tool_input: { command: 7 } })]) {
        const r = spawnSync("node", [GATE], { cwd: b.repo, env: { ...process.env, CLAUDE_PROJECT_DIR: b.repo }, input, encoding: "utf8" });
        expect(r.status).toBe(0);
        expect(r.stdout + r.stderr).toBe("");
      }
    });
  });
});
