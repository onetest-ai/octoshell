import { describe, expect, it } from "vitest";
import { autoResolution, louvain } from "../src/louvain.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi: number): Edge => ({
  a, b, support: 5, npmi, confidence: 0.8,
});

/** Node ids grouped by community, communities ordered by their lowest member.
 *  Compares the *partition* rather than the arbitrary label each community
 *  happens to carry. */
const groups = (parts: Map<number, number>): number[][] => {
  const byComm = new Map<number, number[]>();
  for (const [node, comm] of parts) {
    const bucket = byComm.get(comm);
    if (bucket) bucket.push(node);
    else byComm.set(comm, [node]);
  }
  return [...byComm.values()]
    .map((members) => [...members].sort((x, y) => x - y))
    .sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
};

describe("autoResolution", () => {
  it("follows gamma = max(0.3, 1 - 0.2*log10(n))", () => {
    expect(autoResolution(1)).toBe(1.0);
    expect(autoResolution(100)).toBeCloseTo(0.6, 5);
    expect(autoResolution(1_000_000)).toBe(0.3);
  });

  it("floors at 0.3 from the knee onward, not before it", () => {
    // 1 - 0.2*log10(n) crosses 0.3 at n = 10^3.5 ~= 3163. Pinning both sides of
    // the knee is what distinguishes the real curve from a step function that
    // happens to agree at n = 1, 100 and 1e6.
    expect(autoResolution(3_000)).toBeGreaterThan(0.3);
    expect(autoResolution(3_000)).toBeCloseTo(0.30458, 5);
    expect(autoResolution(4_000)).toBe(0.3);
    expect(autoResolution(1_000_000_000)).toBe(0.3);
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
    // Every member of both triangles, so a partition that strands node 5 on its
    // own still fails.
    expect(groups(parts)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it("is deterministic across runs", () => {
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.8), edge(2, 3, 0.7),
      edge(3, 4, 0.6), edge(4, 0, 0.5),
    ];
    expect([...louvain(edges)]).toEqual([...louvain(edges)]);
  });

  it("gives the same partition whatever order the edges arrive in", () => {
    // Calling the same pure function twice cannot fail — it only rules out a
    // clock or an RNG. The determinism that actually threatens a committed
    // artifact is a dependence on Map/Set insertion order, which tracks the
    // order of the input array. Reorder it and the partition, and the community
    // labels themselves, must not move.
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.9), edge(0, 2, 0.9),
      edge(3, 4, 0.9), edge(4, 5, 0.9), edge(3, 5, 0.9),
      edge(6, 7, 0.7), edge(7, 8, 0.7), edge(6, 8, 0.7),
      edge(2, 3, 0.05), edge(5, 6, 0.05),
    ];
    const baseline = [...louvain(edges)];
    expect([...louvain([...edges].reverse())]).toEqual(baseline);
    expect([...louvain([...edges.slice(4), ...edges.slice(0, 4)])]).toEqual(baseline);
    // Ids are ascending so the artifact diffs line by line, not as a reshuffle.
    expect(baseline.map(([node]) => node)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("omits excluded nodes but still clusters everyone else", () => {
    const edges = [edge(0, 1, 0.9), edge(1, 2, 0.9), edge(0, 2, 0.9)];
    const parts = louvain(edges, { exclude: new Set([1]) });
    expect(parts.has(1)).toBe(false);
    // Asserting only the absence above is satisfied by returning an empty map,
    // so pin the survivors: node 1's edges go, the 0-2 edge does not.
    expect(groups(parts)).toEqual([[0, 2]]);
  });

  it("treats a negative nPMI as separation, never as a link", () => {
    // A negative nPMI means the pair co-changes *less* than chance, so a file
    // whose every edge is negative belongs with nobody.
    expect(groups(louvain([edge(0, 1, -0.9), edge(1, 2, -0.5)]))).toEqual([[0], [1], [2]]);

    // Node 2 reaches the graph only through nPMI -0.46 to node 0 and -0.81 to
    // node 1, so it must stay on its own. Feeding the raw nPMI to the weights
    // instead of clamping at 0 lands it in node 0's community — a signed
    // weight also shrinks each endpoint's strength and the graph total, which
    // deflates the null-model penalty that keeps unrelated files apart. Both
    // sides of that are why the clamp is not merely defensive.
    const signed = [
      edge(0, 1, 0.19), edge(0, 2, -0.46), edge(0, 4, 0.73),
      edge(1, 2, -0.81), edge(1, 3, 0.59),
    ];
    expect(groups(louvain(signed))).toEqual([[0, 4], [1, 3], [2]]);
  });

  it("returns an all-singleton partition when no edge carries positive weight", () => {
    expect(groups(louvain([edge(0, 1, 0), edge(1, 2, -0.4)]))).toEqual([[0], [1], [2]]);
    expect([...louvain([])]).toEqual([]);
  });

  it("honours an explicit resolution over the auto-tuned one", () => {
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.9), edge(0, 2, 0.9),
      edge(3, 4, 0.9), edge(4, 5, 0.9), edge(3, 5, 0.9),
      edge(2, 3, 0.05),
    ];
    // gamma only scales the null-model penalty, so raising it has to make the
    // partition strictly finer: at 5 the penalty outweighs even a 0.9 nPMI
    // triangle and nothing clusters at all. A resolution the gain quietly
    // ignored would keep returning the auto-tuned two triangles.
    expect(groups(louvain(edges))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(groups(louvain(edges, { resolution: 5 }))).toEqual([[0], [1], [2], [3], [4], [5]]);
  });
});
