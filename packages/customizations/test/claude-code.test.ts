import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeReader } from "../src/claude-code.js";
import { DEFAULT_SKIP_DIRS } from "../src/types.js";

function fixture(): { projectDir: string; userDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "ccp-"));
  const userDir = mkdtempSync(join(tmpdir(), "ccu-"));
  mkdirSync(join(projectDir, "packages/api/.claude/agents"), { recursive: true });
  writeFileSync(join(projectDir, "packages/api/.claude/agents/reviewer.md"), `---\nname: reviewer\ndescription: Reviews API code.\n---\nbody`);
  mkdirSync(join(projectDir, ".claude/agents/qa-engineer"), { recursive: true });
  writeFileSync(join(projectDir, ".claude/agents/qa-engineer/AGENT.md"), `---\nname: qa-engineer\ndescription: >\n  Meticulous QA engineer.\n---\n# QA`);
  writeFileSync(join(projectDir, ".claude/agents/qa-engineer/SOUL.md"), `soul`);
  mkdirSync(join(projectDir, ".claude/agents/review"), { recursive: true });
  writeFileSync(join(projectDir, ".claude/agents/review/security.md"), `---\nname: security-reviewer\ndescription: Security review.\n---`);
  mkdirSync(join(projectDir, ".claude/skills/deploy"), { recursive: true });
  writeFileSync(join(projectDir, ".claude/skills/deploy/SKILL.md"), `---\nname: deploy\ndescription: Deploys the app.\npaths: "**/deploy/**"\n---`);
  writeFileSync(join(projectDir, "CLAUDE.md"), `# Root rules\nstuff`);
  writeFileSync(join(projectDir, "packages/api/CLAUDE.md"), `# API rules`);
  mkdirSync(join(projectDir, ".claude/rules"), { recursive: true });
  writeFileSync(join(projectDir, ".claude/rules/db.md"), `---\npaths: "**/migrations/**"\n---\n# DB rule`);
  writeFileSync(join(projectDir, ".claude/settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
  }));
  writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { refero: { url: "https://x" } } }));
  mkdirSync(join(projectDir, "packages/legacy"), { recursive: true });
  writeFileSync(join(projectDir, "packages/legacy/CLAUDE.md"), `# legacy`);
  writeFileSync(join(projectDir, ".claude/settings.local.json"), JSON.stringify({ claudeMdExcludes: ["**/packages/legacy/**"] }));
  mkdirSync(join(userDir, "agents"), { recursive: true });
  writeFileSync(join(userDir, "agents/helper.md"), `---\nname: helper\ndescription: My helper.\n---`);
  return { projectDir, userDir };
}

function ctx(projectDir: string, userDir: string) {
  return { projectDir, claudeConfigDir: userDir, homeDir: userDir, skipDirs: new Set(DEFAULT_SKIP_DIRS), maxItems: 1000 };
}

describe("claudeCodeReader", () => {
  it("finds nested agents with frontmatter and correct scope/location/editable", () => {
    const { projectDir, userDir } = fixture();
    const items = claudeCodeReader.read(ctx(projectDir, userDir));
    const reviewer = items.find((i) => i.kind === "agent" && i.name === "reviewer")!;
    expect(reviewer).toMatchObject({ provider: "claude-acp", scope: "project", description: "Reviews API code.", editable: true });
    expect(reviewer.location?.replace(/\\/g, "/")).toBe("packages/api");
    expect(items.find((i) => i.kind === "agent" && i.scope === "user")).toMatchObject({ name: "helper", editable: false });
    const qa = items.find((i) => i.kind === "agent" && i.name === "qa-engineer")!;
    expect(qa).toMatchObject({ scope: "project", description: "Meticulous QA engineer.", editable: true });
    expect(qa.file.path.replace(/\\/g, "/")).toContain("/.claude/agents/qa-engineer/AGENT.md");
    // SOUL.md is not an agent
    expect(items.some((i) => i.file.path.endsWith("SOUL.md"))).toBe(false);
    expect(items.find((i) => i.kind === "agent" && i.name === "security-reviewer")).toMatchObject({ scope: "project", description: "Security review." });
    rmSync(projectDir, { recursive: true, force: true }); rmSync(userDir, { recursive: true, force: true });
  });

  it("finds skills with paths, instructions (root+nested) honoring claudeMdExcludes, rules, hooks, mcp", () => {
    const { projectDir, userDir } = fixture();
    const items = claudeCodeReader.read(ctx(projectDir, userDir));
    expect(items.find((i) => i.kind === "skill" && i.name === "deploy")).toMatchObject({ paths: "**/deploy/**" });
    const instr = items.filter((i) => i.kind === "instruction").map((i) => i.name.replace(/\\/g, "/"));
    expect(instr).toContain("CLAUDE.md");
    expect(instr).toContain("packages/api/CLAUDE.md");
    expect(instr).not.toContain("packages/legacy/CLAUDE.md");
    const rule = items.find((i) => i.kind === "instruction" && i.name.includes("rules/db.md"))!;
    expect(rule).toMatchObject({ paths: "**/migrations/**", description: "DB rule" });
    expect(items.find((i) => i.kind === "hook")).toMatchObject({ locator: { key: "PreToolUse" }, description: "echo hi" });
    expect(items.find((i) => i.kind === "mcp")).toMatchObject({ name: "refero", locator: { key: "refero" }, description: "https://x" });
    rmSync(projectDir, { recursive: true, force: true }); rmSync(userDir, { recursive: true, force: true });
  });

  it("requires a name frontmatter; lists name-only agents without a description", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ccp-"));
    const userDir = mkdtempSync(join(tmpdir(), "ccu-"));
    mkdirSync(join(projectDir, ".claude/agents"), { recursive: true });
    writeFileSync(join(projectDir, ".claude/agents/no-name.md"), `no frontmatter here`);            // not a subagent
    writeFileSync(join(projectDir, ".claude/agents/named.md"), `---\nname: named-agent\n---\nbody`); // name only, no description
    const items = claudeCodeReader.read(ctx(projectDir, userDir));
    expect(items.some((i) => i.kind === "agent" && i.file.path.endsWith("no-name.md"))).toBe(false);
    expect(items.find((i) => i.kind === "agent" && i.name === "named-agent")).toMatchObject({ description: undefined });
    rmSync(projectDir, { recursive: true, force: true }); rmSync(userDir, { recursive: true, force: true });
  });

  it("does not corrupt a directory name containing '.claude' as a substring", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ccp-"));
    const userDir = mkdtempSync(join(tmpdir(), "ccu-"));
    mkdirSync(join(projectDir, "my.claude-utils"), { recursive: true });
    writeFileSync(join(projectDir, "my.claude-utils/CLAUDE.md"), "# x");
    const items = claudeCodeReader.read({ projectDir, claudeConfigDir: userDir, homeDir: userDir, skipDirs: new Set(DEFAULT_SKIP_DIRS), maxItems: 1000 });
    const inst = items.find((i) => i.kind === "instruction" && i.name.replace(/\\/g, "/") === "my.claude-utils/CLAUDE.md")!;
    expect(inst.location?.replace(/\\/g, "/")).toBe("my.claude-utils");
    rmSync(projectDir, { recursive: true, force: true }); rmSync(userDir, { recursive: true, force: true });
  });
});
