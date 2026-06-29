import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCustomizations } from "../src/aggregate.js";
import { DEFAULT_SKIP_DIRS } from "../src/types.js";

describe("readCustomizations", () => {
  it("runs only the enabled providers' readers", () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-"));
    mkdirSync(join(dir, ".claude/agents"), { recursive: true });
    writeFileSync(join(dir, ".claude/agents/a.md"), `---\nname: a\n---`);
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github/copilot-instructions.md"), "# c");
    const ctx = { projectDir: dir, claudeConfigDir: join(dir, "nope"), homeDir: dir, skipDirs: new Set(DEFAULT_SKIP_DIRS), maxItems: 100 };

    const onlyClaude = readCustomizations(ctx, ["claude-acp"]);
    expect(onlyClaude.some((i) => i.provider === "claude-acp")).toBe(true);
    expect(onlyClaude.some((i) => i.provider === "github-copilot-cli")).toBe(false);

    const both = readCustomizations(ctx, ["claude-acp", "github-copilot-cli"]);
    expect(both.some((i) => i.provider === "github-copilot-cli")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
