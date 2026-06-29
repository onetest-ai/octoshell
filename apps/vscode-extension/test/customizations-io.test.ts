import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomizationsIo } from "../src/host/customizations-io.js";

let root: string;
let io: CustomizationsIo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cust-io-"));
  io = new CustomizationsIo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("CustomizationsIo", () => {
  describe("readCustomizationFile", () => {
    it("reads a file within the project root as editable", () => {
      const filePath = join(root, ".claude", "settings.json");
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(filePath, `{"key":"val"}`, "utf8");
      const result = io.readCustomizationFile(filePath);
      expect(result.text).toBe(`{"key":"val"}`);
      expect(result.editable).toBe(true);
    });

    it("reads a file within CLAUDE_CONFIG_DIR as read-only", () => {
      const configDir = mkdtempSync(join(tmpdir(), "claude-config-"));
      const priorEnv = process.env["CLAUDE_CONFIG_DIR"];
      try {
        process.env["CLAUDE_CONFIG_DIR"] = configDir;
        const filePath = join(configDir, "settings.json");
        writeFileSync(filePath, `{"config":"value"}`, "utf8");
        const result = io.readCustomizationFile(filePath);
        expect(result.text).toBe(`{"config":"value"}`);
        expect(result.editable).toBe(false);
      } finally {
        process.env["CLAUDE_CONFIG_DIR"] = priorEnv;
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it("throws for a path outside allowed roots", () => {
      const outside = join(tmpdir(), "outside.txt");
      writeFileSync(outside, "secret", "utf8");
      expect(() => io.readCustomizationFile(outside)).toThrow(/path outside allowed roots/);
    });
  });

  describe("writeCustomizationFile", () => {
    it("writes a file within the project root", () => {
      const filePath = join(root, ".claude", "settings.local.json");
      const result = io.writeCustomizationFile(filePath, `{"hooks":{}}`);
      expect(result).toEqual({ ok: true });
      expect(existsSync(filePath)).toBe(true);
    });

    it("throws for a path outside the project root", () => {
      const outside = join(tmpdir(), "bad.txt");
      expect(() => io.writeCustomizationFile(outside, "x")).toThrow(/writes are project-only/);
    });
  });

  describe("addCustomization", () => {
    it("creates an agent file", () => {
      const result = io.addCustomization({ provider: "claude-acp", kind: "agent", name: "my-agent" });
      expect(result.path).toContain(".claude/agents/my-agent.md");
      expect(existsSync(result.path)).toBe(true);
    });

    it("creates a skill file", () => {
      const result = io.addCustomization({ provider: "claude-acp", kind: "skill", name: "my-skill" });
      expect(result.path).toContain(".claude/skills/my-skill/SKILL.md");
      expect(existsSync(result.path)).toBe(true);
    });

    it("creates an instruction file", () => {
      const result = io.addCustomization({ provider: "claude-acp", kind: "instruction", name: "my-rule" });
      expect(result.path).toContain(".claude/rules/my-rule.md");
      expect(existsSync(result.path)).toBe(true);
    });

    it("creates a hook config file (idempotent)", () => {
      const r1 = io.addCustomization({ provider: "claude-acp", kind: "hook" });
      const r2 = io.addCustomization({ provider: "claude-acp", kind: "hook" });
      expect(r1.path).toContain(".claude/settings.local.json");
      expect(r1.path).toBe(r2.path); // idempotent
    });

    it("throws for unknown provider", () => {
      expect(() => io.addCustomization({ provider: "other", kind: "agent", name: "x" })).toThrow(/only claude-acp/);
    });

    it("throws when name is required but missing", () => {
      expect(() => io.addCustomization({ provider: "claude-acp", kind: "agent" })).toThrow(/name required/);
    });

    it("throws if the file already exists", () => {
      io.addCustomization({ provider: "claude-acp", kind: "agent", name: "dup" });
      expect(() => io.addCustomization({ provider: "claude-acp", kind: "agent", name: "dup" })).toThrow(/already exists/);
    });
  });
});
