import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";

// Direct unit tests for the hooks' shared module. The hook tests drive it end to end through a
// child process; these pin the parser edges and the fail-closed paths that a real board never hits.
// Each call runs in a child `node`, as the hooks themselves do, so V8 coverage of child processes
// counts these lines.
const STATUS_FLIP = pathToFileURL(join(__dirname, "..", "resources", "octobots-pack", "hooks", "status-flip.mjs")).href;
const ENTITY_IO = join(".claude", "skills", "mission-planner", "scripts", "entity-io.mjs");

/** Evaluate `expr` (with the module bound to `f` and `args` to the extra argv) in a child node; return its JSON value. */
function flip(expr: string, ...args: string[]): unknown {
  const src = `import * as f from ${JSON.stringify(STATUS_FLIP)}; const args = process.argv.slice(1);` +
    `console.log(JSON.stringify(await (${expr})));`;
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", src, ...args], { encoding: "utf8" }));
}

/** A project whose installed entity-io.mjs throws the moment it is imported. */
function brokenProject(prefix: string): string {
  const repo = mkdtempClean(prefix);
  const helper = join(repo, ENTITY_IO);
  mkdirSync(join(helper, ".."), { recursive: true });
  writeFileSync(helper, 'throw new Error("broken entity-io");\n', "utf8");
  return repo;
}

describe("status-flip.mjs shellWords", () => {
  it("exposes ENTITY_IO at the path installPack writes mission-planner's scripts to", () => {
    expect(flip("f.ENTITY_IO")).toBe(ENTITY_IO);
  });

  it("unescapes \\\" and \\\\ inside double quotes, keeping other backslashes", () => {
    expect(flip("f.shellWords(args[0])", 'a "x \\"y\\" \\\\ \\n"')).toEqual([["a", 'x "y" \\ \\n']]);
  });

  it("treats a backslash outside quotes as an escape, and backslash-newline as a continuation", () => {
    expect(flip("f.shellWords(args[0])", "a\\ b c\\\nd")).toEqual([["a b", "cd"]]);
  });

  it("drops a redirection glued to a word, with its target", () => {
    expect(flip("f.shellWords(args[0])", "echo hi>out tail")).toEqual([["echo", "hi", "tail"]]);
  });
});

describe("status-flip.mjs parseTransitionLines", () => {
  it("skips a line whose quoted title is not a valid JSON string literal", () => {
    expect(flip("f.parseTransitionLines(args[0])", 'octobots: status mission "M1 \\x" draft -> done')).toEqual([]);
  });

  it("stays linear on a long adversarial line (no catastrophic backtracking)", () => {
    const expr =
      "(() => { const line = 'octobots: status mission \"M1\" a' + ' -> b'.repeat(200000) + ' c d';" +
      " const t0 = performance.now(); const r = f.parseTransitionLines(line); return { r, ms: performance.now() - t0 }; })()";
    const out = flip(expr) as { r: unknown[]; ms: number };
    expect(out.r).toEqual([]);
    expect(out.ms).toBeLessThan(1000);
  });
});

describe("status-flip.mjs fails closed when the installed resolver cannot load", () => {
  const call = JSON.stringify({ parent: ".", title: "M1 - Venue ingest", state: "done" });

  it("confirmedTransitions returns nothing although stdout carries a matching transition line", () => {
    const repo = brokenProject("octo-flip-broken-a-");
    const evt = JSON.stringify({ cwd: repo, tool_response: { stdout: 'octobots: status mission "M1 - Venue ingest" draft -> done\n' } });
    expect(flip("f.confirmedTransitions([JSON.parse(args[0])], JSON.parse(args[1]), args[2])", call, evt, repo)).toEqual([]);
  });

  it("statusNowEquals answers false instead of throwing", () => {
    const repo = brokenProject("octo-flip-broken-b-");
    expect(flip("f.statusNowEquals(JSON.parse(args[0]), args[1], args[1])", call, repo)).toBe(false);
  });
});
