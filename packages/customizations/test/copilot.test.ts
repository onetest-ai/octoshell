import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotReader } from "../src/copilot.js";
import { DEFAULT_SKIP_DIRS } from "../src/types.js";

describe("copilotReader", () => {
  it("reads .github/copilot-instructions.md and AGENTS.md as instructions", () => {
    const dir = mkdtempSync(join(tmpdir(), "cop-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github/copilot-instructions.md"), "# Copilot rules");
    writeFileSync(join(dir, "AGENTS.md"), "# Agents guide");
    const items = copilotReader.read({ projectDir: dir, claudeConfigDir: dir, homeDir: dir, skipDirs: new Set(DEFAULT_SKIP_DIRS), maxItems: 100 });
    const names = items.filter((i) => i.kind === "instruction").map((i) => i.name);
    expect(names).toContain(".github/copilot-instructions.md");
    expect(names).toContain("AGENTS.md");
    expect(items.every((i) => i.provider === "github-copilot-cli")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
