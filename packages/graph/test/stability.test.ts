import { describe, expect, it } from "vitest";
import { jaccard, remapClusters } from "../src/stability.js";

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint ones", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("treats two empty sets as 0 rather than NaN", () => {
    // Arithmetic only. Whether two MEMBERLESS clusters are the same cluster is
    // a remap policy decided in `remapClusters` (see the memberless test
    // below), not something this function is asked.
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

  // `louvain` and `detectHubs` both pin ascending iteration order so the
  // artifact diffs line by line; the remap is the third module a renderer
  // iterates. Built greedily best-first, its own order tracks Jaccard score, so
  // an unrelated cluster gaining one file reorders every line downstream of it.
  it("iterates in ascending new-cluster order, not in score order", () => {
    const oldC = new Map([[10, ["a", "b", "c", "d"]], [11, ["x", "y", "z", "w"]]]);
    // New cluster 1 matches perfectly (1.0); new cluster 0 matches at 0.6, so
    // the greedy pass claims 1 first and a score-ordered map starts with it.
    const newC = new Map([[0, ["a", "b", "c", "e"]], [1, ["x", "y", "z", "w"]]]);
    expect([...remapClusters(oldC, newC).entries()]).toEqual([[0, 10], [1, 11]]);
  });

  it("is stable when nothing changed at all", () => {
    const clusters = new Map([[0, ["a", "b"]], [1, ["c", "d"]]]);
    const remap = remapClusters(clusters, clusters);
    expect(remap.get(0)).toBe(0);
    expect(remap.get(1)).toBe(1);
  });

  /**
   * `analyze()` emits memberless clusters — a Graphify-declared module with no
   * churn inside the harvest window (see analyze.test.ts's own
   * "a declared module the harvest window never touched" case). Scored by raw
   * Jaccard those overlap their own previous self by 0, so they re-minted an id
   * on EVERY run and the committed artifact churned forever with nothing
   * changing. `remapClusters` scores overlap through `overlap`, which counts
   * two memberless clusters as a full match.
   */
  it("keeps a memberless cluster's id instead of re-minting it every run", () => {
    const clusters = new Map([[0, ["a", "b"]], [1, []]]);
    const once = remapClusters(clusters, clusters);
    expect([...once.entries()]).toEqual([[0, 0], [1, 1]]);

    // Applied twice, as consecutive runs of an unchanged repo would: an id
    // that only survives one round is still churn.
    const twice = remapClusters(new Map([[0, ["a", "b"]], [1, []]]), clusters);
    expect([...twice.entries()]).toEqual([[0, 0], [1, 1]]);
  });

  it("never gives one old memberless id to two new memberless clusters", () => {
    const oldC = new Map([[4, []]]);
    const newC = new Map([[0, []], [1, []]]);
    const remap = remapClusters(oldC, newC);
    expect(remap.get(0)).toBe(4);
    // The second one has no old id left to inherit, so it mints above max(old)
    // rather than colliding with the first.
    expect(remap.get(1)).toBe(5);
  });

  it("never lets a memberless cluster claim an old id that has members", () => {
    const remap = remapClusters(new Map([[2, ["a", "b"]]]), new Map([[0, []]]));
    expect(remap.get(0)).toBe(3);
  });

  /**
   * `nextId` was `Math.max(...oldClusters.keys()) + 1`, over the keys exactly
   * as handed in. `analyze`'s `previousClusters` is a public option whose keys
   * normally come from `Number()`-ing a `clusters.json` object key, so one key
   * that does not parse arrives here as `NaN` — after which `Math.max` is
   * `NaN`, `nextId++` stays `NaN`, and EVERY unmatched cluster is assigned the
   * same id. A caller writing that back collapses its whole partition onto one
   * entry, and (because `Map.has(NaN)` is true) reports every module as a KEPT
   * id while it does so.
   *
   * `artifact.ts`'s `CLUSTER_KEY` guard stops such a document reaching a
   * caller at all; this is the same defect closed for any other caller, and
   * it asserts the property that actually matters: fresh ids are finite and
   * DISTINCT.
   */
  it.each([
    ["NaN", NaN],
    ["a fraction", 1.5],
    ["a negative id", -3],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("mints distinct finite ids when an old id is %s", (_name, poison) => {
    const oldC = new Map<number, string[]>([[poison, ["p"]], [4, ["a", "b"]]]);
    const newC = new Map<number, string[]>([
      [0, ["a", "b"]], // matches old 4
      [1, ["x"]],
      [2, ["y"]],
    ]);
    const remap = remapClusters(oldC, newC);

    expect(remap.get(0)).toBe(4);
    const minted = [remap.get(1), remap.get(2)];
    for (const id of minted) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(4);
    }
    // The whole point: two clusters, two ids. The bug gave both the same one.
    expect(new Set([...remap.values()]).size).toBe(3);
  });
});
