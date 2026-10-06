// T1.3 / M1-AC8: the test-case panel's own sources carry no colour literal: every colour is a VS Code theme-token class.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const FILES = ["../src/webview/test-case-view.tsx", "../src/webview/markdown.tsx"];

/** Every colour literal form the AC names: #rgb / #rrggbb(aa), rgb(, rgba(, hsl(, hsla(, and a named colour in a style attribute. */
export function colourLiterals(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) hits.push(m[0]);
  for (const m of source.matchAll(/style=\{\{([^}]*)\}\}|style="([^"]*)"/g)) {
    const css = m[1] ?? m[2] ?? "";
    for (const n of css.matchAll(/(?:color|background(?:Color)?|border(?:Color)?|fill|stroke)\s*:\s*["']?\s*([a-zA-Z]+)\b/g)) {
      if (!["inherit", "currentColor", "transparent", "none", "var"].includes(n[1]!)) hits.push(n[0]);
    }
  }
  return hits;
}

describe("colourLiterals (the check itself)", () => {
  it("flags each literal form the criterion names", () => {
    for (const bad of ['c="#fff"', 'c="#ff00aa"', "rgb(1,2,3)", "rgba(1,2,3,.5)", "hsl(1 2% 3%)", '<i style={{ color: "red" }} />', '<i style="background-color: tomato" />'])
      expect(colourLiterals(bad), bad).not.toEqual([]);
  });
  it("passes theme-token classes and var() colours", () => {
    expect(colourLiterals('<i className="text-status-warning bg-list-hover" style={{ color: "var(--vscode-foreground)" }} />')).toEqual([]);
  });
});

describe("the test-case panel sources", () => {
  for (const f of FILES) {
    it(`${f.split("/").pop()} has no colour literal`, () => {
      expect(colourLiterals(read(f))).toEqual([]);
    });
  }
});
