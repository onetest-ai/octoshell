import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { installPrimer, registerClaudeHook, unregisterClaudeHook, claudeHookStatus } from "../src/host/octobots-hooks.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

function freshRepo(): string {
  return mkdtempClean("octo-hooks-");
}

describe("octobots-hooks: primer copy", () => {
  it("copies primer.mjs into <repo>/.octobots/hooks", () => {
    const repo = freshRepo();
    installPrimer(PACK_SRC, repo);
    expect(existsSync(join(repo, ".octobots", "hooks", "primer.mjs"))).toBe(true);
    expect(existsSync(join(repo, ".octobots", "hooks", "package.json"))).toBe(true);
  });

  it("ships the work log alongside the primer, so attribution works out of the box", () => {
    const repo = freshRepo();
    installPrimer(PACK_SRC, repo);
    expect(existsSync(join(repo, ".octobots", "hooks", "work-log.mjs"))).toBe(true);
  });
});

describe("octobots-hooks: Claude registration", () => {
  it("creates settings.json with SessionStart + PreCompact entries tagged _octobots", () => {
    const repo = freshRepo();
    registerClaudeHook(repo, 9);
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const ss = s.hooks.SessionStart.find((e: any) => e._octobots === 9);
    expect(ss).toBeTruthy();
    expect(ss.hooks[0].command).toContain("primer.mjs");
    expect(ss.hooks[0].command).toContain("--backend claude");
    expect(s.hooks.PreCompact.some((e: any) => e._octobots === 9)).toBe(true);
    expect(claudeHookStatus(repo, 9)).toEqual({ present: true, current: true });
  });

  it("registers the work log on PostToolUse(Bash), async so it cannot delay a tool call", () => {
    const repo = freshRepo();
    registerClaudeHook(repo, 9);
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const ptu = s.hooks.PostToolUse.find((e: any) => e._octobots === 9);
    expect(ptu).toBeTruthy();
    expect(ptu.matcher).toBe("Bash");
    expect(ptu.hooks[0].command).toContain("work-log.mjs");
    expect(ptu.hooks[0].async).toBe(true);
  });

  it("registers the mission gate on PostToolUse, synchronously so it can steer the agent", () => {
    const repo = freshRepo();
    registerClaudeHook(repo, 9);
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const gate = s.hooks.PostToolUse.find((e: any) => e.hooks[0].command.includes("mission-gate.mjs"));
    expect(gate).toBeTruthy();
    expect(gate.matcher).toBe("Bash");
    // Must NOT be async: it injects a directive the orchestrator has to act on.
    expect(gate.hooks[0].async).toBe(false);
    expect(s.hooks.PostToolUse.filter((e: any) => e._octobots === 9)).toHaveLength(2);
  });

  it("reports an install predating PostToolUse as not present, so re-running repairs it", () => {
    const repo = freshRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    // An older pack registered SessionStart + PreCompact only.
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ _octobots: 9, hooks: [{ type: "command", command: "primer.mjs" }] }],
          PreCompact: [{ _octobots: 9, hooks: [{ type: "command", command: "primer.mjs" }] }],
        },
      }),
    );
    expect(claudeHookStatus(repo, 9).present).toBe(false);
    registerClaudeHook(repo, 9);
    expect(claudeHookStatus(repo, 9)).toEqual({ present: true, current: true });
  });

  it("merges without clobbering pre-existing hooks (e.g. sdlc-skills)", () => {
    const repo = freshRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", _bundle: "sdlc-core", hooks: [{ type: "command", command: "sdlc" }] }] } }),
    );
    registerClaudeHook(repo, 9);
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.SessionStart.some((e: any) => e._bundle === "sdlc-core")).toBe(true); // preserved
    expect(s.hooks.SessionStart.some((e: any) => e._octobots === 9)).toBe(true); // added
  });

  it("throws on a malformed settings.json instead of clobbering it", () => {
    const repo = freshRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const path = join(repo, ".claude", "settings.json");
    const bad = '{ "theme": "dark", "hooks": { ,, } }'; // malformed
    writeFileSync(path, bad);
    expect(() => registerClaudeHook(repo, 9)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(bad); // untouched, not clobbered
  });

  it("is idempotent and refreshes an older version in place (no duplicates)", () => {
    const repo = freshRepo();
    registerClaudeHook(repo, 8);
    registerClaudeHook(repo, 9);
    registerClaudeHook(repo, 9);
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const ours = s.hooks.SessionStart.filter((e: any) => e._octobots !== undefined);
    expect(ours).toHaveLength(1);
    expect(ours[0]._octobots).toBe(9);
    expect(claudeHookStatus(repo, 8)).toEqual({ present: true, current: false });
  });
  /**
   * The field bug this guards: an entry written before `_octobots` existed carries no marker, so a
   * marker-only filter left it in place and appended a marked twin beside it. Observed on a real
   * board — primer.mjs twice on SessionStart, work-log.mjs and mission-gate.mjs twice each on
   * PostToolUse — meaning every Bash tool call paid four hook processes instead of two, and no
   * amount of reinstalling could clear it.
   */
  it("replaces an UNMARKED prior entry instead of duplicating it", () => {
    const repo = freshRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            // no _octobots marker — exactly what an older install left behind
            { matcher: "startup|clear|compact|resume", hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.octobots/hooks/primer.mjs" --backend claude' }] },
            // somebody else's hook — must survive untouched
            { matcher: "*", hooks: [{ type: "command", command: "./other-tool/run.sh" }] },
          ],
          PostToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.octobots/hooks/work-log.mjs"' }] },
            { matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.octobots/hooks/mission-gate.mjs"' }] },
          ],
        },
      }, null, 2),
    );

    registerClaudeHook(repo, 9);
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));

    const primer = s.hooks.SessionStart.filter((e: any) =>
      e.hooks.some((h: any) => h.command.includes("primer.mjs")));
    expect(primer).toHaveLength(1);
    expect(primer[0]._octobots).toBe(9);

    for (const script of ["work-log.mjs", "mission-gate.mjs"]) {
      const hit = s.hooks.PostToolUse.filter((e: any) =>
        e.hooks.some((h: any) => h.command.includes(script)));
      expect(hit, script).toHaveLength(1);
      expect(hit[0]._octobots, script).toBe(9);
    }

    // a third party's hook is none of our business
    expect(s.hooks.SessionStart.some((e: any) =>
      e.hooks.some((h: any) => h.command === "./other-tool/run.sh"))).toBe(true);
  });

  it("reports an unmarked-only install as present but not current, so an upgrade repairs it", () => {
    const repo = freshRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: ".octobots/hooks/primer.mjs" }] }],
        PreCompact: [{ hooks: [{ type: "command", command: ".octobots/hooks/primer.mjs" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: ".octobots/hooks/work-log.mjs" }] }],
      },
    }));
    expect(claudeHookStatus(repo, 9)).toEqual({ present: true, current: false });
  });

  it("unregister removes only our entries and leaves other tools' alone", () => {
    const repo = freshRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./other-tool/run.sh" }] }] },
    }));
    registerClaudeHook(repo, 9);
    expect(claudeHookStatus(repo, 9).present).toBe(true);

    const dropped = unregisterClaudeHook(repo);
    expect(dropped).toBeGreaterThan(0);
    expect(claudeHookStatus(repo, 9).present).toBe(false);

    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("./other-tool/run.sh");
  });
});
