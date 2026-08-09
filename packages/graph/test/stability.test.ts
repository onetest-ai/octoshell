import { describe, expect, it } from "vitest";
import { jaccard, remapClusters } from "../src/stability.js";

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint ones", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("treats two empty sets as 0 rather than NaN", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe("remapClusters", () => {
  it("keeps the old id when membership is mostly preserved", () => {
    const oldC = new Map([[7, ["a", "b", "c", "d"]]]);
    const newC = new Map([[0, ["a", "b", "c", "e"]]]); // jaccard 3/5 = 0.6
    expect(remapClusters(oldC, newC).get(0)).toBe(7);
  });

  it("issues a fresh id when the cluster is genuinely new", () => {
    const oldC = new Map([[7, ["a", "b"]]]);
    const newC = new Map([[0, ["x", "y", "z"]]]);
    expect(remapClusters(oldC, newC).get(0)).toBe(8); // max(old) + 1
  });

  it("never assigns one old id to two new clusters", () => {
    const oldC = new Map([[3, ["a", "b", "c", "d"]]]);
    const newC = new Map([
      [0, ["a", "b"]],
      [1, ["c", "d"]],
    ]);
    const remap = remapClusters(oldC, newC, { threshold: 0.3 });
    expect(new Set(remap.values()).size).toBe(2);
  });

  it("is stable when nothing changed at all", () => {
    const clusters = new Map([[0, ["a", "b"]], [1, ["c", "d"]]]);
    const remap = remapClusters(clusters, clusters);
    expect(remap.get(0)).toBe(0);
    expect(remap.get(1)).toBe(1);
  });
});
