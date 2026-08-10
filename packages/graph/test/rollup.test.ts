import { describe, expect, it } from "vitest";
import { modulePageRank, nameCluster, pageRank, rollUp } from "../src/rollup.js";
import type { Edge } from "../src/weights.js";
import type { ModuleEdge } from "../src/rollup.js";

const edge = (a: number, b: number, npmi = 0.5): Edge => ({
  a, b, support: 4, npmi, confidence: 0.5,
});

describe("pageRank", () => {
  it("ranks a well-connected node above a leaf", () => {
    const edges = [edge(0, 1), edge(0, 2), edge(0, 3)];
    const pr = pageRank(edges, [0, 1, 2, 3]);
    expect(pr.get(0) ?? 0).toBeGreaterThan(pr.get(1) ?? 0);
  });

  it("scores only the requested nodes and conserves the whole rank mass", () => {
    const pr = pageRank([edge(0, 1), edge(0, 2), edge(0, 3)], [0, 1, 2, 3]);
    expect([...pr.keys()]).toEqual([0, 1, 2, 3]);
    expect([...pr.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
  });

  it("ignores an edge leaving the node set instead of leaking rank into it", () => {
    // Node 2 is deliberately absent from the node set: `pageRank` scores the
    // subgraph induced by `nodes`, so the 0-2 edge is not part of this graph
    // at all. Half-applying it would send node 0's share to a node the
    // iteration never visits, so the mass would vanish rather than be
    // redistributed — silently depressing every node with an outbound edge.
    const pr = pageRank([edge(0, 2)], [0, 1]);
    expect([...pr.keys()]).toEqual([0, 1]);
    expect([...pr.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    // Both nodes are isolated in the induced subgraph, so neither outranks the other.
    expect(pr.get(0) ?? 0).toBeCloseTo(pr.get(1) ?? 0, 10);
  });
});

describe("modulePageRank", () => {
  const me = (from: string, to: string, weight: number): ModuleEdge => ({ from, to, weight });

  it("ranks a well-connected module above one connected to it only weakly", () => {
    const edges = [me("a", "b", 10), me("b", "c", 1)];
    const pr = modulePageRank(edges, ["a", "b", "c"]);
    expect(pr.get("b") ?? 0).toBeGreaterThan(pr.get("a") ?? 0);
    expect(pr.get("b") ?? 0).toBeGreaterThan(pr.get("c") ?? 0);
  });

  it("scores only the requested modules and conserves the whole rank mass", () => {
    const pr = modulePageRank([me("a", "b", 1)], ["a", "b", "c"]);
    expect([...pr.keys()]).toEqual(["a", "b", "c"]);
    expect([...pr.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
  });

  it("gives isolated modules with no edges an equal, non-zero score", () => {
    const pr = modulePageRank([], ["x", "y"]);
    expect(pr.get("x") ?? 0).toBeCloseTo(pr.get("y") ?? 0, 10);
    expect(pr.get("x") ?? 0).toBeGreaterThan(0);
  });
});

describe("nameCluster", () => {
  it("returns the most central members, most central first", () => {
    const files = ["hub.ts", "leaf1.ts", "leaf2.ts", "leaf3.ts"];
    const edges = [edge(0, 1), edge(0, 2), edge(0, 3)];
    expect(nameCluster([0, 1, 2, 3], edges, files, 2)[0]).toBe("hub.ts");
  });

  it("ranks by centrality rather than echoing the given member order", () => {
    // The hub is not the first member, so an implementation that skipped
    // ranking and just sliced `members` would still pass the test above.
    const files = ["leaf1.ts", "hub.ts", "leaf2.ts", "leaf3.ts"];
    const edges = [edge(1, 0), edge(1, 2), edge(1, 3)];
    expect(nameCluster([0, 1, 2, 3], edges, files, 2)).toEqual(["hub.ts", "leaf1.ts"]);
  });
});

describe("rollUp", () => {
  const files = ["pkg/a/x.ts", "pkg/a/y.ts", "pkg/b/z.ts"];
  const moduleOf = (p: string) => p.split("/").slice(0, 2).join("/");

  it("drops intra-module edges", () => {
    expect(rollUp([edge(0, 1)], files, moduleOf)).toHaveLength(0);
  });

  it("sums weights across collapsed edges", () => {
    const edges = [edge(0, 2, 0.4), edge(1, 2, 0.3)];
    const rolled = rollUp(edges, files, moduleOf);
    expect(rolled).toHaveLength(1);
    expect(rolled[0]?.weight).toBeCloseTo(0.7, 5);
  });

  it("orders endpoints deterministically", () => {
    const rolled = rollUp([edge(2, 0, 0.5)], files, moduleOf);
    expect(rolled[0]?.from).toBe("pkg/a");
    expect(rolled[0]?.to).toBe("pkg/b");
  });

  it("breaks weight ties on code units, not on locale collation", () => {
    // "pkg/B" < "pkg/a" by code unit, but collates *after* it in en-US (and
    // differently again in da-DK). A locale-sensitive comparator would order
    // this committed artifact by whatever LANG the machine happened to have.
    const cased = ["pkg/B/x.ts", "pkg/a/y.ts", "pkg/c/z.ts"];
    const rolled = rollUp([edge(0, 2, 0.5), edge(1, 2, 0.5)], cased, moduleOf);
    expect(rolled.map((m) => m.from)).toEqual(["pkg/B", "pkg/a"]);
  });

  // Every other consumer of `Edge` floors nPMI at zero, because a negative one
  // means the pair co-changes LESS than chance — evidence of separation, not a
  // link that subtracts. `rollUp` summed the raw signed value, so an
  // anti-correlated cross-module pair silently cancelled real coupling out of a
  // committed artifact, and a module pair could surface carrying a negative or
  // exactly-zero "dependency" weight the rest of the engine does not claim.
  it("never lets an anti-correlated pair subtract from a module edge", () => {
    const spread = ["pkg/a/x.ts", "pkg/b/y.ts", "pkg/a/z.ts", "pkg/b/w.ts"];
    const rolled = rollUp([edge(0, 1, 0.5), edge(2, 3, -0.6)], spread, moduleOf);
    expect(rolled).toHaveLength(1);
    expect(rolled[0]?.weight).toBeCloseTo(0.5, 10);
  });

  it("emits no module edge at all when every crossing pair is non-positive", () => {
    // The stronger half of the same property: with the raw sum these produced a
    // `pkg/a -> pkg/b` edge weighing -0.9, -0.4 and 0 respectively — an
    // architectural dependency asserted from evidence of its own absence.
    const spread = ["pkg/a/x.ts", "pkg/b/y.ts", "pkg/a/z.ts", "pkg/b/w.ts"];
    expect(rollUp([edge(0, 1, -0.9)], spread, moduleOf)).toEqual([]);
    expect(rollUp([edge(0, 1, -0.9), edge(2, 3, 0.5)], spread, moduleOf)).toEqual([
      { from: "pkg/a", to: "pkg/b", weight: 0.5 },
    ]);
    expect(rollUp([edge(0, 1, 0)], spread, moduleOf)).toEqual([]);
  });

  it("keeps module pairs distinct when a module name contains a space", () => {
    // ("a", "b c") and ("a b", "c") share the string "a b c": a space-joined
    // accumulator key merges two unrelated module edges into one.
    const spaced = ["a/x.ts", "b c/y.ts", "a b/z.ts", "c/w.ts"];
    const topLevel = (p: string) => p.split("/")[0] ?? "";
    const rolled = rollUp([edge(0, 1, 0.5), edge(2, 3, 0.25)], spaced, topLevel);
    expect(rolled.map((m) => [m.from, m.to, m.weight])).toEqual([
      ["a", "b c", 0.5],
      ["a b", "c", 0.25],
    ]);
  });
});
