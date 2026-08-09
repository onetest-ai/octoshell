import { describe, expect, it } from "vitest";
import { bridgeComponents, findComponents } from "../src/components.js";
import { louvain } from "../src/louvain.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi = 0.7): Edge => ({
  a, b, support: 3, npmi, confidence: 0.6,
});

/** The subgraph clustering actually sees — louvain weights by max(0, npmi). */
const clusterable = (edges: Edge[]): Edge[] => edges.filter((e) => e.npmi > 0);

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

  it("bridges a component held on only by a non-positive edge", () => {
    // 3 is reachable from the cluster only through a co-change that happens
    // LESS than chance would predict. Clustering discards that edge, so 3 is
    // an isolated singleton there — exactly the junk module bridging exists
    // to absorb — even though the raw edge list looks connected.
    const edges = [edge(0, 1), edge(1, 2), edge(2, 3, -0.4)];
    const bridged = bridgeComponents(edges, files);

    const synthetic = bridged.filter((e) => e.support === 0);
    expect(synthetic).toHaveLength(1);
    expect(findComponents(clusterable(bridged), [0, 1, 2, 3])).toHaveLength(1);

    const community = louvain(bridged);
    expect(community.get(3)).toBe(community.get(0));
  });

  it("picks the directory-similar target over the largest one", () => {
    const tree = [
      "src/core/a.ts", "src/core/b.ts", "src/core/c.ts", // largest component
      "docs/guide/x.md", "docs/guide/y.md",
      "docs/guide/z.md", "docs/guide/w.md",
    ];
    const edges = [edge(0, 1), edge(1, 2), edge(3, 4), edge(5, 6)];
    const synthetic = bridgeComponents(edges, tree)
      .filter((e) => e.support === 0)
      .map((e) => [e.a, e.b]);

    // {5,6} shares docs/guide with {3,4} and nothing with the bigger src/core
    // component, so it must attach to {3,4} — not to whatever is largest.
    expect(synthetic).toEqual([[0, 3], [3, 5]]);
  });
});
