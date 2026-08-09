import { describe, expect, it } from "vitest";
import { impact } from "../src/impact.js";
import type { Edge } from "../src/weights.js";

const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
const edges: Edge[] = [
  { a: 0, b: 1, support: 9, npmi: 0.9, confidence: 0.9 },
  { a: 0, b: 2, support: 4, npmi: 0.4, confidence: 0.4 },
  { a: 2, b: 3, support: 8, npmi: 0.8, confidence: 0.8 },
];

describe("impact", () => {
  it("returns coupled files ranked by nPMI", () => {
    const rows = impact("a.ts", edges, files);
    expect(rows.map((r) => r.path)).toEqual(["b.ts", "c.ts"]);
  });

  it("follows edges in either direction", () => {
    expect(impact("d.ts", edges, files).map((r) => r.path)).toEqual(["c.ts"]);
  });

  it("returns an empty list for an unknown path rather than throwing", () => {
    expect(impact("nope.ts", edges, files)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(impact("a.ts", edges, files, 1)).toHaveLength(1);
  });
});
