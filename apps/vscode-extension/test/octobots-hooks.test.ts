import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPrimer, registerClaudeHook, claudeHookStatus } from "../src/host/octobots-hooks.js";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

function freshRepo(): string {
  return mkdtempSync(join(tmpdir(), "octo-hooks-"));
}

describe("octobots-hooks: primer copy", () => {
  it("copies primer.mjs into <repo>/.octobots/hooks", () => {
    const repo = freshRepo();
    installPrimer(PACK_SRC, repo);
    expect(existsSync(join(repo, ".octobots", "hooks", "primer.mjs"))).toBe(true);
    expect(existsSync(join(repo, ".octobots", "hooks", "package.json"))).toBe(true);
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
});

