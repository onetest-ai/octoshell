/**
 * CustomizationsIo — host-side file I/O for Claude customization files
 * (reading, writing, and appending customization entries from the workspace).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { CustomizationKind } from "@octoshell/customizations";

export class CustomizationsIo {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  readCustomizationFile(filePath: string): { text: string; editable: boolean } {
    const project = this.projectRoot;
    const defaultClaudeDir = join(homedir(), ".claude");
    const claudeConfigDir = resolve(process.env["CLAUDE_CONFIG_DIR"] ?? defaultClaudeDir);
    const globalJson = resolve(
      claudeConfigDir === resolve(defaultClaudeDir)
        ? join(homedir(), ".claude.json")
        : join(claudeConfigDir, ".claude.json"),
    );
    const target = resolve(filePath);
    const within = (root: string): boolean => target === root || target.startsWith(root + sep);
    if (within(project)) return { text: readFileSync(target, "utf8"), editable: true };
    if (within(claudeConfigDir) || target === globalJson) return { text: readFileSync(target, "utf8"), editable: false };
    throw new Error(`readCustomizationFile: path outside allowed roots: ${filePath}`);
  }

  writeCustomizationFile(filePath: string, content: string): { ok: true } {
    const project = this.projectRoot;
    const target = resolve(filePath);
    if (!(target === project || target.startsWith(project + sep))) {
      throw new Error(`writeCustomizationFile: writes are project-only: ${filePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { ok: true };
  }

  addCustomization(input: { provider: string; kind: CustomizationKind; name?: string }): { path: string } {
    if (input.provider !== "claude-acp") {
      throw new Error(`addCustomization: only claude-acp is supported in v1 (got ${input.provider})`);
    }
    const root = this.projectRoot;
    const slug = (input.name ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const templateA = (name: string): string => `---\nname: ${name}\ndescription: \n---\n\n`;
    const templateB = (name: string): string => `---\npaths: "**"\n---\n\n# ${name}\n`;
    const writeNew = (rel: string, content: string): string => {
      const abs = join(root, rel);
      if (existsSync(abs)) throw new Error(`addCustomization: already exists: ${rel}`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return abs;
    };
    const ensureConfig = (rel: string, scaffold: string): string => {
      const abs = join(root, rel);
      if (!existsSync(abs)) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, scaffold, "utf8");
      }
      return abs;
    };
    switch (input.kind) {
      case "agent":
        if (!slug) throw new Error("addCustomization: name required");
        return { path: writeNew(`.claude/agents/${slug}.md`, templateA(input.name as string)) };
      case "skill":
        if (!slug) throw new Error("addCustomization: name required");
        return { path: writeNew(`.claude/skills/${slug}/SKILL.md`, templateA(input.name as string)) };
      case "instruction":
        if (!slug) throw new Error("addCustomization: name required");
        return { path: writeNew(`.claude/rules/${slug}.md`, templateB(input.name as string)) };
      case "hook":
        return { path: ensureConfig(`.claude/settings.local.json`, `{\n  "hooks": {}\n}\n`) };
      case "mcp":
        return { path: ensureConfig(`.mcp.json`, `{\n  "mcpServers": {}\n}\n`) };
      default:
        throw new Error(`addCustomization: unknown kind ${String(input.kind)}`);
    }
  }
}
