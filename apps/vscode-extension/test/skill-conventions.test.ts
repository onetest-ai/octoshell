import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");
const skill = (name: string): string => readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");

/** Body of the `### Dispatch rules` section: up to the next heading of the same or a higher level. */
function dispatchRulesSection(text: string): string {
  const start = text.search(/^###\s+Dispatch rules\b.*$/m);
  expect(start, "mission-execution has a '### Dispatch rules' section").toBeGreaterThanOrEqual(0);
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const next = rest.search(/^#{1,3}\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("mission-execution: direct sub-agent dispatch", () => {
  const text = skill("mission-execution");
  const rules = (): string => dispatchRulesSection(text);

  it("§ Dispatch rules are numbered 1..n with no duplicates or gaps", () => {
    const numbers = [...rules().matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThanOrEqual(9);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  // One entry per dispatch rule (or the loop section that carries it): the keyword that rule needs.
  const keywords: Array<[string, RegExp]> = [
    ["Agent tool", /`Agent` tool|Agent\(/],
    ["foreground", /foreground/i],
    ["explicit model:", /`model:`|model: (opus|sonnet)/],
    ["fenced JSON verdict", /fenced JSON/],
    ["missing verdict is BLOCKED", /BLOCKED/],
    ["relay questions instead of nested spawning", /relay/i],
    ["resume from board + git", /board[^.]*\bgit\b|\bgit log\b/i],
    ["fast lane", /\bfast\b[^.\n]*\blane\b/i],
    ["coverage lane", /\bcoverage\b[^.\n]*\blane\b/i],
  ];
  it.each(keywords)("carries the rule keyword: %s", (_label, pattern) => {
    expect(text).toMatch(pattern);
  });

  it("the rule keywords sit in § Dispatch rules, not only elsewhere in the file", () => {
    for (const [, pattern] of keywords.filter(([l]) => /model|JSON|BLOCKED|relay|lane|foreground/.test(l))) {
      expect(rules()).toMatch(pattern);
    }
  });

  const forbidden: Array<[string, RegExp]> = [
    ["Workflow( tool call", /Workflow\(/],
    ["Workflow script path", /scriptPath/],
    ["workflow resume id", /resumeFromRunId/],
    ["workflow run logging / meta scripts", /add-run\.js|sync-meta\.js/],
    ["retired workflow-designer skill", /workflow-designer/],
    ["a backticked make command", /`make\s/],
    ["make ci / make <x>-test", /\bmake\s+(ci|coverage|[\w-]*-test[\w-]*)\b/],
    ["edgeserver", /edgeserver/],
    ["uv run", /uv run/],
  ];
  it.each(forbidden)("does not contain %s", (_label, pattern) => {
    expect(text).not.toMatch(pattern);
  });

  it("never instructs running a workflow.js: any paragraph naming it is the historical-reference note", () => {
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.includes("workflow.js") && !/^#{1,6}\s/.test(p));
    expect(paragraphs.length).toBeGreaterThan(0); // the legacy paragraph is kept
    for (const p of paragraphs) expect(p.replace(/[*\s]+/g, " ")).toMatch(/historical reference only/);
  });

  it("stays at the shared pack version", () => {
    expect(text).toMatch(/^version: 57$/m);
  });
});
