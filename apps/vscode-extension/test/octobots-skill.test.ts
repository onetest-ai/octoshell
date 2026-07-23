import { readFileSync, mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  parseVersion,
  requiredSkillsForAgent,
  OCTOBOTS_PACK_VERSION,
  OCTOBOTS_AGENTS,
  OCTOBOTS_SKILLS,
  installPack,
  packStatus,
} from "../src/host/octobots-skill.js";
import { registerClaudeHook } from "../src/host/octobots-hooks.js";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

describe("octobots-skill helpers", () => {
  it("parses the version: frontmatter field, or null when absent", () => {
    expect(parseVersion("---\nname: octobots\nversion: 3\n---\nbody")).toBe(3);
    expect(parseVersion("---\nname: octobots\n---\nbody")).toBeNull();
    expect(parseVersion("no frontmatter")).toBeNull();
  });

  it("every managed agent requires both pack skills", () => {
    for (const agent of ["scout", "any-agent"]) {
      expect(requiredSkillsForAgent(agent)).toContain("mission-planner");
      expect(requiredSkillsForAgent(agent)).toContain("mission-execution");
    }
  });

  it("bundles no dedicated planning agents — planning lives in the mission-planner skill", () => {
    expect(OCTOBOTS_AGENTS).toEqual([]);
  });
});

describe("bundled pack payloads", () => {
  it.each(OCTOBOTS_SKILLS)("%s carries a matching name + pack version", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    expect(skill).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, "m"));
    expect(parseVersion(skill)).toBe(OCTOBOTS_PACK_VERSION);
  });

  it.each(OCTOBOTS_SKILLS)("%s describes when to use it, not what it does", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^description: Use when /m);
  });

  // Four sibling skills all trigger inside an .octobots/ repo, so a description that only says when
  // to use a skill leaves the model guessing between them. Each must also say what it is NOT for.
  it.each(OCTOBOTS_SKILLS)("%s says what it is not for, to disambiguate from its siblings", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    expect(description).toMatch(/\bNot for\b/);
  });

  it.each(OCTOBOTS_SKILLS)("%s does not name an agent the pack never installs", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    // OCTOBOTS_AGENTS is empty: the pack ships skills and a hook, no agents. A skill that tells an
    // agent to call `octobots-planner` sends it after something that is not on disk.
    expect(skill).not.toMatch(/agent: ['"`]octobots-(planner|orchestrator)['"`]/);
  });
});

describe("installPack + packStatus (real payload → temp repo)", () => {
  it("reports not-installed before install, up-to-date after", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    expect(packStatus(repo).installed).toBe(false);

    const res = installPack(PACK_SRC, repo);
    expect(res.written).toBeGreaterThanOrEqual(9); // 2 SKILL.md + 6 scripts + package.json

    for (const name of OCTOBOTS_SKILLS) {
      expect(existsSync(join(repo, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(repo, ".claude", "skills", "mission-planner", "scripts", "validate.js"))).toBe(true);

    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(true);
  });

  it("removes the retired `octobots` skill dir a pre-rename pack left behind", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    const stale = join(repo, ".claude", "skills", "octobots");
    mkdirSync(join(stale, "scripts"), { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), "---\nname: octobots\nversion: 18\n---\nold");

    installPack(PACK_SRC, repo);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "mission-planner", "SKILL.md"))).toBe(true);
  });

  it.each(OCTOBOTS_SKILLS)("reports not-installed when %s has no version field", (name) => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    // Corrupt one skill payload by stripping its frontmatter version.
    writeFileSync(join(repo, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody`);
    const st = packStatus(repo);
    expect(st.installed).toBe(false);
    expect(st.upToDate).toBe(false);
  });

  it.each(OCTOBOTS_SKILLS)("reports not-installed when %s is missing entirely", (name) => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    rmSync(join(repo, ".claude", "skills", name), { recursive: true, force: true });
    expect(packStatus(repo).installed).toBe(false);
  });

  it("reports not-up-to-date when an installed payload is older", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    expect(packStatus(repo, 999).upToDate).toBe(false);
  });

  it("installs the primer + Claude hook, and reports up-to-date only when both are current", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    expect(existsSync(join(repo, ".octobots", "hooks", "primer.mjs"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart.some((e: any) => e._octobots === OCTOBOTS_PACK_VERSION)).toBe(true);

    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(true);
  });

  it("reports not-installed when the Claude hook registration is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    const st = packStatus(repo);
    expect(st.installed).toBe(false);
    expect(st.upToDate).toBe(false);
  });

  it("reports installed but not-up-to-date when the Claude hook is a stale version", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    registerClaudeHook(repo, OCTOBOTS_PACK_VERSION - 1); // downgrade our hook entry in place
    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(false);
  });

  it("does not throw when .claude/settings.json is malformed (returns not-up-to-date)", () => {
    const repo = mkdtempSync(join(tmpdir(), "octobots-pack-"));
    installPack(PACK_SRC, repo);
    writeFileSync(join(repo, ".claude", "settings.json"), "{ bad json ,, }");
    expect(() => packStatus(repo)).not.toThrow();
    expect(packStatus(repo).upToDate).toBe(false);
  });

});
