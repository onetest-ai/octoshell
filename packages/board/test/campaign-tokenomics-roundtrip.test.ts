/**
 * A campaign can declare `tokenomics.branches` (branches that are campaign-level work, e.g. the
 * campaign's own planning branch). Both on-disk forms the rollup accepts - a YAML list and a
 * comma-separated string - must survive every writer: the pack's scripts, and the app's
 * entity-schema. The two schema implementations also have to agree byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCampaign, createMission } from "../src/write.js";
import { loadEntity, dumpEntity, type EntityFields } from "../src/entity-schema.js";
import { validateBoard } from "../src/validate.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);
const io = (await import(pathToFileURL(join(SCRIPTS, "entity-io.mjs")).href)) as {
  loadEntity: (text: string) => Record<string, unknown>;
  dumpEntity: (kind: string, fields: Record<string, unknown>) => string;
};
const { load: yamlLoad } = (await import(pathToFileURL(join(SCRIPTS, "vendor/js-yaml.mjs")).href)) as {
  load: (text: string) => Record<string, unknown>;
};

const runScript = (name: string, args: string[], cwd: string) =>
  execFileSync("node", [join(SCRIPTS, name), ...args], { cwd, encoding: "utf8" });

let projectDir: string;
let boardRoot: string;
let campaignYaml: string;
let campaignFolder: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "campaign-tok-"));
  boardRoot = join(projectDir, ".octobots");
  mkdirSync(boardRoot);
  const c = createCampaign(boardRoot, { name: "Camp" });
  createMission(boardRoot, c.id, { title: "M1 - First", acceptanceCriteria: "- [ ] ac" });
  campaignFolder = join(boardRoot, c.folderPath);
  campaignYaml = join(campaignFolder, "campaign.yaml");
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

/** Seed through the parser, as the scripts require, then return the file text. */
function seedBranches(branches: unknown): string {
  const f = loadEntity(readFileSync(campaignYaml, "utf8"));
  writeFileSync(campaignYaml, dumpEntity("campaign", { ...f, tokenomics: { branches } }), "utf8");
  return readFileSync(campaignYaml, "utf8");
}

describe("campaign tokenomics.branches", () => {
  it("list form survives add-doc.js", () => {
    seedBranches(["chore/camp-plan", "chore/camp-retro"]);
    runScript("add-doc.js", [campaignYaml, "spec", "docs/spec.md"], projectDir);
    const after = yamlLoad(readFileSync(campaignYaml, "utf8"));
    expect(after.tokenomics).toEqual({ branches: ["chore/camp-plan", "chore/camp-retro"] });
    expect(after.documents).toEqual([{ label: "spec", target: "docs/spec.md" }]);
  });

  it("comma-string form survives set-status.js", () => {
    seedBranches("chore/camp-plan , chore/camp-retro");
    runScript("set-status.js", [campaignFolder, "M1 - First", "active"], projectDir);
    const after = yamlLoad(readFileSync(campaignYaml, "utf8"));
    expect(after.tokenomics).toEqual({ branches: "chore/camp-plan , chore/camp-retro" });
  });

  it("TS loadEntity->dumpEntity is byte-stable and emits tokenomics before notes", () => {
    const text = dumpEntity("campaign", {
      name: "Camp",
      description: "d",
      acceptanceCriteria: [],
      documents: [],
      tokenomics: { branches: ["a/b"] },
      notes: "decision",
    } as EntityFields);
    expect(text.indexOf("tokenomics:")).toBeGreaterThan(-1);
    expect(text.indexOf("tokenomics:")).toBeLessThan(text.indexOf("notes:"));
    expect(dumpEntity("campaign", loadEntity(text))).toBe(text);
  });

  it("pack entity-io dump equals TS dump for the same campaign", () => {
    const fields = {
      name: "Camp",
      description: "d",
      acceptanceCriteria: [{ text: "x", done: false }],
      documents: [{ label: "spec", target: "docs/spec.md" }],
      status: "active",
      tokenomics: { branches: ["chore/camp-plan"] },
      notes: "decision",
    };
    expect(io.dumpEntity("campaign", fields)).toBe(dumpEntity("campaign", fields as unknown as EntityFields));
  });

  it("validate.ts and validate.js report no 'not a campaign field' finding", () => {
    seedBranches(["chore/camp-plan"]);
    expect(validateBoard(boardRoot).filter((f) => f.message.includes("not a campaign field"))).toEqual([]);
    const r = spawnSync("node", [join(SCRIPTS, "validate.js"), campaignYaml], { cwd: projectDir, encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).not.toContain("not a campaign field");
  });
});
