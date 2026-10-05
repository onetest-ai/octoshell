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
    for (const [, pattern] of keywords.filter(([l]) => /Agent tool|model|JSON|BLOCKED|relay|resume|lane|foreground/.test(l))) {
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

  it("rule 10 (dead agent) indents its continuation lines by 4 spaces like every other rule", () => {
    const rule10 = rules().split(/^10\. /m)[1] ?? "";
    const continuation = rule10.split("\n").slice(1).filter((l) => l.trim() !== "");
    expect(continuation.length).toBeGreaterThan(0);
    for (const line of continuation) expect(line).toMatch(/^ {4}\S/);
  });

  it("the Fixing loop sends a bug fix through review, then QA + land, before merge", () => {
    const fixing = text.split(/^- \*\*Fixing\*\*/m)[1]?.split(/\n\n/)[0] ?? "";
    expect(fixing).toMatch(/review/i);
    expect(fixing).toMatch(/QA \+ land/);
    expect(fixing).toMatch(/before (it )?merg/i);
  });

  it("§ The mission gate speaks direct dispatch: base branch goes in the briefs, no workflow-era names", () => {
    const section = text.split(/^## The mission gate\b.*$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/baseBranch|MISSION_TASKS_MERGED|`args`|\bargs\b/);
    expect(section).toMatch(/base branch[^.]*\b(briefs?|dispatch)/i);
  });
});

describe("mission-completion-gate: orchestrator-dispatched phases", () => {
  const text = skill("mission-completion-gate");
  const gate = (): string => text.split(/^## The gate\b.*$/m)[1]?.split(/^## /m)[0] ?? "";

  it("states the 5 phases as orchestrator dispatches with the Agent tool, in the foreground", () => {
    const phases = [...gate().matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect(phases).toEqual([
      "1:Tests + coverage",
      "2:QA, black-box (Sage)",
      "3:Critical review (Rio)",
      "4:Tokenomics capture (non-blocking)",
      "5:Merge / complete",
    ]);
    expect(gate()).toMatch(/`Agent` tool/);
    expect(gate()).toMatch(/foreground/);
    expect(gate()).toMatch(/model:/);
    expect(gate()).toMatch(/BLOCKED/);
  });

  it("relays the Sage-Alex and Rio-devs exchanges through the orchestrator", () => {
    expect(gate()).toMatch(/relay/i);
    expect(gate()).toMatch(/questions_for_ba/);
    expect(gate()).toMatch(/questions_for_devs/);
    expect(text).not.toMatch(/calls Py[^.]*directly/i);
  });

  it("defines blocking: an AC demonstrably unmet, a reproducible defect, or a security exposure with a PoC", () => {
    expect(text).toMatch(/AC demonstrably unmet[\s\S]{0,40}reproducible defect[\s\S]{0,40}security exposure with a PoC/);
  });

  it("allows one review round plus one fix round, residue filed as board bugs; blocks on stillOpen only", () => {
    expect(gate()).toMatch(/one review round and one fix round/i);
    expect(gate()).toMatch(/[Rr]esidue[^.]*filed as board bugs/);
    expect(gate()).toMatch(/Block on `stillOpen` only/);
  });

  it("defines green: 0 failed, 0 xfailed or todo, no skip without an environmental reason", () => {
    expect(gate()).toMatch(/0 failed, 0 xfailed or todo/);
    expect(gate()).toMatch(/no skip without a stated environmental reason/);
  });

  it("runs coverage on the coverage lane only, and names no project-specific command", () => {
    expect(gate()).toMatch(/coverage lane/);
    expect(gate()).toMatch(/fast lane/);
    expect(text).toMatch(/AGENTS\.md § Test lanes/);
    expect(text).not.toMatch(/`make\s|\bmake\s+(ci|coverage|[\w-]*-test[\w-]*)\b|edgeserver|uv run|-n auto/);
  });

  it("is free of the retired Workflow-tool template and its names", () => {
    expect(text).not.toMatch(/Workflow\(|export const meta|workflow-designer|baseBranch|TESTS_SCHEMA|agentType:/);
    expect(text).toMatch(/Do not use the `Workflow` tool/);
  });

  it("describes the real transcript roots, not only .claude/projects/", () => {
    expect(text).toMatch(/~\/\.claude\/projects\/<slug>/);
    expect(text).toMatch(/\$CLAUDE_CONFIG_DIR\/projects/);
    expect(text).not.toMatch(/transcripts live in `\.claude\/projects\/`/);
  });

  it("keeps the campaign rows in the runs.json description and the shared pack version", () => {
    expect(text).toMatch(/work_item_level: "campaign"/);
    expect(text).toMatch(/^version: 57$/m);
  });
});
