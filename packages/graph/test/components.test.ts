import { describe, expect, it } from "vitest";
import { bridgeComponents, findComponents } from "../src/components.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number): Edge => ({
  a, b, support: 3, npmi: 0.7, confidence: 0.6,
});

describe("findComponents", () => {
  it("groups nodes reachable from each other", () => {
    const comps = findComponents([edge(0, 1), edge(2, 3)], [0, 1, 2, 3]);
    expect(comps).toHaveLength(2);
    expect(comps.map((c) => c.length).sort()).toEqual([2, 2]);
  });
});

describe("bridgeComponents", () => {
  const files = ["src/a/one.ts", "src/a/two.ts", "src/b/three.ts", "src/b/four.ts"];

  it("connects an isolated component to the most directory-similar one", () => {
    const bridged = bridgeComponents([edge(0, 1), edge(2, 3)], files);
    expect(bridged.length).toBeGreaterThan(2);
    expect(findComponents(bridged, [0, 1, 2, 3])).toHaveLength(1);
  });

  it("gives bridges a low weight so they connect without distorting", () => {
    const bridged = bridgeComponents([edge(0, 1), edge(2, 3)], files);
    const synthetic = bridged.filter((e) => e.support === 0);
    expect(synthetic.length).toBeGreaterThan(0);
    for (const s of synthetic) expect(s.npmi).toBeLessThan(0.1);
  });

  it("adds nothing when the graph is already connected", () => {
    const edges = [edge(0, 1), edge(1, 2), edge(2, 3)];
    expect(bridgeComponents(edges, files)).toHaveLength(edges.length);
  });
});
