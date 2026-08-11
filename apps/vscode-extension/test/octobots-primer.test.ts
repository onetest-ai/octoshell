import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PRIMER = join(__dirname, "..", "resources", "octobots-pack", "hooks", "primer.mjs");

function run(backend: string, cwd: string, event = "SessionStart"): string {
  return execFileSync("node", [PRIMER, "--backend", backend], {
    cwd,
    input: JSON.stringify({ hook_event_name: event }),
    encoding: "utf8",
  });
}

function repoWithOctobots(): string {
  const dir = mkdtempClean("octo-repo-");
  mkdirSync(join(dir, ".octobots"), { recursive: true });
  return dir;
}

/** A board repo, optionally with `.octobots/graph/map.md` written with `content`. */
function repoWithMap(content: string | undefined): string {
  const dir = repoWithOctobots();
  if (content !== undefined) {
    mkdirSync(join(dir, ".octobots", "graph"), { recursive: true });
    writeFileSync(join(dir, ".octobots", "graph", "map.md"), content);
  }
  return dir;
}

/** Every one of these must survive in all three map.md cases — the map block is additive. */
function expectPreExistingPrimerContent(additionalContext: string): void {
  expect(additionalContext).toContain("Octobots");
  expect(additionalContext).toMatch(/file bugs on the board/i);
  expect(additionalContext).toMatch(/Epic\/Story\/Task/i);
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
    const dir = mkdtempClean("plain-repo-");
    expect(run("claude", dir).trim()).toBe("");
  });

  describe("map.md injection", () => {
    it("injects map.md's body when present and under the size cap", () => {
      const marker = "octograph-map-body-marker: module a -> module b";
      const dir = repoWithMap(`# Architecture map\n\n${marker}\n`);
      const ctx = JSON.parse(run("claude", dir)).hookSpecificOutput.additionalContext;
      expect(ctx).toContain(marker);
      expectPreExistingPrimerContent(ctx);
    });

    it("emits a one-line pointer, never the map body, when map.md is present but over the cap", () => {
      const big = "x".repeat(200_000); // comfortably over any sane byte cap
      const dir = repoWithMap(big);
      const ctx = JSON.parse(run("claude", dir)).hookSpecificOutput.additionalContext;
      expect(ctx).not.toContain(big.slice(0, 200)); // no fragment of the body, truncated or not
      expect(ctx).toMatch(/\.octobots\/graph\/map\.md/);
      expectPreExistingPrimerContent(ctx);

      // The appended block (after the pre-existing primer, separated by a blank line) is exactly
      // one line — a pointer, not a document.
      const parts = ctx.split("\n\n");
      const pointer = parts[parts.length - 1] as string;
      expect(pointer.includes("\n")).toBe(false);
      expect(pointer).toMatch(/\.octobots\/graph\/map\.md/);
    });

    it("emits that same one-line pointer, naming where the map would be and how to build it, when there is no map.md at all", () => {
      const dir = repoWithMap(undefined);
      const ctx = JSON.parse(run("claude", dir)).hookSpecificOutput.additionalContext;
      expect(ctx).toMatch(/\.octobots\/graph\/map\.md/);
      expect(ctx).toMatch(/octograph\.mjs setup|Install Graph/);
      expectPreExistingPrimerContent(ctx);

      const parts = ctx.split("\n\n");
      const pointer = parts[parts.length - 1] as string;
      expect(pointer.includes("\n")).toBe(false);
    });
  });
});
