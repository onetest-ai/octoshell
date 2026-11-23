import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RETIRED_PACK_PATHS, commentSyntaxOf, isJudgedPackPath, packFileEntryName, packFileRel } from "../src/host/pack-files.js";
import { OCTOBOTS_SKILLS, RETIRED_SKILLS } from "../src/host/pack-skills.js";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack");

function walk(dir: string, rel = ""): string[] {
  return readdirSync(dir).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), r) : [r];
  });
}

describe("pack-path model", () => {
  it.each([
    ["skill/mission-planner/scripts/validate.js", true],
    ["skill/mission-planner/templates/TC-template.md", true],
    ["skill/mission-planner/SKILL.md", false],
    ["skill/mission-planner/scripts/package.json", false],
    ["hooks/primer.mjs", true],
    ["hooks/required-hooks.json", false],
    ["statusline/statusline.sh", true],
    ["tokenomics/collect.mjs", true],
    ["tokenomics/prices.json", false],
    ["tokenomics/prices.local.json", false],
    ["tokenomics/raw/segments.jsonl", false],
    ["graph/octograph.mjs", false],
  ])("isJudgedPackPath(%s) is %s", (p, want) => expect(isJudgedPackPath(p)).toBe(want));

  it("maps pack paths to workspace paths", () => {
    expect(packFileRel("skill/mission-planner/scripts/validate.js")).toBe(".claude/skills/mission-planner/scripts/validate.js");
    expect(packFileRel("hooks/primer.mjs")).toBe(".octobots/hooks/primer.mjs");
    expect(packFileRel("statusline/statusline.sh")).toBe(".octobots/statusline.sh");
    expect(packFileRel("tokenomics/collect.mjs")).toBe(".octobots/tokenomics/collect.mjs");
  });

  it("entry names keep the v60 tokenomics shape and fit every pending reader", () => {
    expect(packFileEntryName("tokenomics/collect.mjs")).toBe("tokenomics-collect-mjs");
    expect(packFileEntryName("skill/mission-planner/scripts/validate.js")).toBe("skill-mission-planner-scripts-validate-js");
    expect(packFileEntryName("statusline/statusline.sh")).toBe("statusline-statusline-sh");
    for (const p of RETIRED_PACK_PATHS) expect(packFileEntryName(p)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("lists retired files as pack paths, never a SKILL.md", () => {
    expect(RETIRED_PACK_PATHS).toContain("skill/mission-planner/scripts/set-step.js");
    expect(RETIRED_PACK_PATHS).toContain("skill/octobots/scripts/validate.js");
    expect(RETIRED_PACK_PATHS.every(isJudgedPackPath)).toBe(true);
    expect(RETIRED_PACK_PATHS).not.toContain("skill/octobots/scripts/package.json");
  });

  it("picks a comment syntax per file type", () => {
    expect(commentSyntaxOf("hooks/primer.mjs")).toBe("//");
    expect(commentSyntaxOf("skill/x/scripts/a.js")).toBe("//");
    expect(commentSyntaxOf("statusline/statusline.sh")).toBe("#");
    expect(commentSyntaxOf("skill/x/templates/T.md")).toBe("<!--");
  });

  it("every judged file in the pack has a distinct entry name and no skill name", () => {
    const judged = walk(PACK).filter(isJudgedPackPath);
    expect(judged.length).toBeGreaterThan(0);
    const all = [...new Set([...judged, ...RETIRED_PACK_PATHS])];
    const names = all.map(packFileEntryName);
    expect(new Set(names).size).toBe(names.length);
    const skills = new Set<string>([...OCTOBOTS_SKILLS, ...RETIRED_SKILLS]);
    for (const n of names) expect(skills.has(n)).toBe(false);
  });
});
