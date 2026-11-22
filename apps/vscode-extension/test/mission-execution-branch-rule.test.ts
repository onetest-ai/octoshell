import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = readFileSync(join(__dirname, "..", "resources", "octobots-pack", "skill", "mission-execution", "SKILL.md"), "utf8");

/** The text of the "Branch rule" subsection, up to the next heading of the same or a higher level. */
function branchRule(): string {
  const start = SKILL.search(/^### Branch rule\s*$/m);
  expect(start, "mission-execution SKILL.md needs a '### Branch rule' subsection").toBeGreaterThanOrEqual(0);
  const rest = SKILL.slice(start).split("\n").slice(1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

describe("mission-execution SKILL.md: the branch rule", () => {
  const rule = branchRule();
  // A clause is a numbered line plus its indented continuation lines.
  const clauses = rule.split(/^(?=\d+\. )/m).filter((c) => /^\d+\. /.test(c)).map((c) => c.replace(/\s+/g, " "));

  it("sits inside Branch topology, which is where the commit hook's warning sends the reader", () => {
    expect(SKILL.indexOf("## Branch topology")).toBeLessThan(SKILL.search(/^### Branch rule\s*$/m));
    expect(SKILL.search(/^### Branch rule\s*$/m)).toBeLessThan(SKILL.indexOf("## No `Workflow` tool"));
  });

  it("has exactly five numbered clauses", () => {
    expect(clauses).toHaveLength(5);
  });

  it.each([
    ["campaign slug on board/, fix/ and chore/ branches", [/board\/<campaign-slug>/, /fix\/<campaign-slug>/, /chore\/<campaign-slug>/]],
    ["-m<n> for mission work and -t<k> for tasks", [/-m<n>/, /-t<k>/]],
    ["the repo's designated tooling campaign slug for reinstalls, ledgers and cross-campaign work", [/tooling campaign/i, /reinstall/i, /ledger/i, /cross-campaign/i]],
    ["the orchestrator never commits on main", [/orchestrator never commits on `main`/]],
    ["an off-convention branch is declared in tokenomics.branches", [/tokenomics\.branches/]],
  ])("clause: %s", (_name, patterns) => {
    const hit = clauses.find((c) => patterns.every((p) => p.test(c)));
    expect(hit, `no clause matches ${patterns.join(" and ")}`).toBeDefined();
  });

  it("names no repo-specific campaign slug", () => {
    expect(rule).not.toMatch(/factory-tooling|factory-budget|push-speed|edgeserver-auth|epic-\d+|h00\d\d|coach-android|aquanautica/i);
  });
});
