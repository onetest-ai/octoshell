// apps/vscode-extension/test/customizations-tree.test.ts
import { describe, it, expect, vi } from "vitest";
import type { CustomizationItem } from "@octoshell/customizations";
import { CustomizationsTree, type CustomizationsSource } from "../src/host/customizations-tree.js";

function fakeSource(items: CustomizationItem[]): CustomizationsSource & { calls: number } {
  return {
    calls: 0,
    listCustomizations() {
      this.calls++;
      return items;
    },
  };
}

const ITEMS = [
  { kind: "agent", name: "A", provider: "claude-code", file: { path: "/x/.claude/agents/A.md" } },
  { kind: "skill", name: "S", provider: "claude-code", file: { path: "/x/.claude/skills/S/SKILL.md" } },
] as unknown as CustomizationItem[];

describe("CustomizationsTree", () => {
  it("walks the workspace at most ONCE per refresh, reused across root + per-group getChildren", () => {
    const src = fakeSource(ITEMS);
    const tree = new CustomizationsTree(src, "/ext");

    const groups = tree.getChildren(); // root → triggers the (only) walk
    expect(groups.map((g) => (g as { group: string }).group)).toEqual(["agent", "skill"]);
    tree.getChildren(groups[0]); // group "agent" → reuses cache
    tree.getChildren(groups[1]); // group "skill" → reuses cache
    expect(src.calls).toBe(1); // not 3 — no re-walk per group
  });

  it("re-walks only after an explicit refresh()", () => {
    const src = fakeSource(ITEMS);
    const tree = new CustomizationsTree(src, "/ext");

    tree.getChildren();
    expect(src.calls).toBe(1);
    tree.refresh(); // invalidate
    tree.getChildren();
    expect(src.calls).toBe(2);
  });

  it("refresh() fires onDidChangeTreeData", () => {
    const src = fakeSource(ITEMS);
    const tree = new CustomizationsTree(src, "/ext");
    const listener = vi.fn();
    tree.onDidChangeTreeData(listener);
    tree.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
