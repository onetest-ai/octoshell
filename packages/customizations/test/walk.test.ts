import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "../src/walk.js";
import { DEFAULT_SKIP_DIRS } from "../src/types.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "walk-"));
  mkdirSync(join(dir, "packages/api/.claude/agents"), { recursive: true });
  writeFileSync(join(dir, "packages/api/.claude/agents/a.md"), "x");
  mkdirSync(join(dir, "node_modules/pkg/.claude/agents"), { recursive: true });
  writeFileSync(join(dir, "node_modules/pkg/.claude/agents/skip.md"), "x");
  writeFileSync(join(dir, "CLAUDE.md"), "x");
  return dir;
}

const ctx = () => ({ skipDirs: new Set(DEFAULT_SKIP_DIRS), maxItems: 100 });

describe("collectFiles", () => {
  it("finds matching files recursively and skips skip-dirs", () => {
    const dir = fixture();
    const got = collectFiles(dir, ctx() as never, (rel) => rel.endsWith(".md")).map((f) => f.rel.replace(/\\/g, "/"));
    expect(got.sort()).toEqual(["CLAUDE.md", "packages/api/.claude/agents/a.md"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("honors maxItems", () => {
    const dir = fixture();
    const got = collectFiles(dir, { skipDirs: new Set(DEFAULT_SKIP_DIRS), maxItems: 1 } as never, () => true);
    expect(got.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
