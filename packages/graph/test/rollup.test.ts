import { describe, expect, it } from "vitest";
import { nameCluster, pageRank, rollUp } from "../src/rollup.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi = 0.5): Edge => ({
  a, b, support: 4, npmi, confidence: 0.5,
});

describe("pageRank", () => {
  it("ranks a well-connected node above a leaf", () => {
    const edges = [edge(0, 1), edge(0, 2), edge(0, 3)];
    const pr = pageRank(edges, [0, 1, 2, 3]);
    expect(pr.get(0) ?? 0).toBeGreaterThan(pr.get(1) ?? 0);
  });
});

describe("nameCluster", () => {
  it("returns the most central members, most central first", () => {
    const files = ["hub.ts", "leaf1.ts", "leaf2.ts", "leaf3.ts"];
    const edges = [edge(0, 1), edge(0, 2), edge(0, 3)];
    expect(nameCluster([0, 1, 2, 3], edges, files, 2)[0]).toBe("hub.ts");
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
});
