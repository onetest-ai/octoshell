import { describe, expect, it } from "vitest";
import { autoResolution, louvain } from "../src/louvain.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi: number): Edge => ({
  a, b, support: 5, npmi, confidence: 0.8,
});

describe("autoResolution", () => {
  it("follows gamma = max(0.3, 1 - 0.2*log10(n))", () => {
    expect(autoResolution(1)).toBe(1.0);
    expect(autoResolution(100)).toBeCloseTo(0.6, 5);
    expect(autoResolution(1_000_000)).toBe(0.3);
  });
});

describe("louvain", () => {
  it("separates two dense clusters joined by one weak edge", () => {
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.9), edge(0, 2, 0.9),
      edge(3, 4, 0.9), edge(4, 5, 0.9), edge(3, 5, 0.9),
      edge(2, 3, 0.05),
    ];
    const parts = louvain(edges);
    expect(parts.get(0)).toBe(parts.get(1));
    expect(parts.get(0)).toBe(parts.get(2));
    expect(parts.get(3)).toBe(parts.get(4));
    expect(parts.get(0)).not.toBe(parts.get(3));
  });

  it("is deterministic across runs", () => {
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.8), edge(2, 3, 0.7),
      edge(3, 4, 0.6), edge(4, 0, 0.5),
    ];
    expect([...louvain(edges)]).toEqual([...louvain(edges)]);
  });

  it("omits excluded nodes from the partition", () => {
    const edges = [edge(0, 1, 0.9), edge(1, 2, 0.9)];
    const parts = louvain(edges, { exclude: new Set([1]) });
    expect(parts.has(1)).toBe(false);
  });
});
