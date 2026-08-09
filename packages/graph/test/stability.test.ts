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
    // Pin which one wins: the tie on score 0.5 breaks toward the lower new id,
    // and the loser takes a fresh id above max(old). A set-size check alone
    // also passes an implementation that inherits nothing at all.
    expect(remap.get(0)).toBe(3);
    expect(remap.get(1)).toBe(4);
  });

  // The candidate sort is the whole determinism guarantee: without it, which
  // new cluster claims a contested old id depends on Map insertion order, i.e.
  // on Louvain's node visit order, which shifts when unrelated files appear.
  // That is exactly the artifact churn this module exists to prevent.
  it("gives a contested old id to the strongest overlap, not the first seen", () => {
    const oldC = new Map([[5, ["a", "b", "c", "d"]]]);
    const newC = new Map([
      [0, ["a", "b", "c"]], // jaccard 3/4 = 0.75, but iterated first
      [1, ["a", "b", "c", "d"]], // jaccard 4/4 = 1
    ]);
    const remap = remapClusters(oldC, newC);
    expect(remap.get(1)).toBe(5);
    expect(remap.get(0)).toBe(6);
  });

  it("pairs clusters by best score regardless of insertion order", () => {
    const oldEntries: Array<[number, string[]]> = [
      [3, ["a", "b", "c", "d"]],
      [9, ["a", "b"]],
    ];
    const newEntries: Array<[number, string[]]> = [
      [0, ["a", "b"]], // 0.5 against old 3, but a perfect 1 against old 9
      [1, ["a", "b", "c", "d"]], // a perfect 1 against old 3
    ];
    const forward = remapClusters(new Map(oldEntries), new Map(newEntries));
    expect(forward.get(0)).toBe(9);
    expect(forward.get(1)).toBe(3);

    const reversed = remapClusters(
      new Map([...oldEntries].reverse()),
      new Map([...newEntries].reverse()),
    );
    expect(reversed.get(0)).toBe(9);
    expect(reversed.get(1)).toBe(3);
  });

  it("is stable when nothing changed at all", () => {
    const clusters = new Map([[0, ["a", "b"]], [1, ["c", "d"]]]);
    const remap = remapClusters(clusters, clusters);
    expect(remap.get(0)).toBe(0);
    expect(remap.get(1)).toBe(1);
  });
});
