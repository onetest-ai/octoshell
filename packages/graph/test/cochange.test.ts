import { describe, expect, it } from "vitest";
import { countPairs } from "../src/cochange.js";
import type { PairStat } from "../src/cochange.js";
import type { Commit } from "../src/types.js";

const NOW = Date.UTC(2026, 0, 1);
const day = 86400000;

function commit(files: string[], daysAgo: number): Commit {
  return { sha: "x".repeat(40), files, timestamp: NOW - daysAgo * day };
}

describe("countPairs", () => {
  it("counts each unordered pair once per commit", () => {
    const table = countPairs([commit(["a", "b", "c"], 0)], { now: NOW });
    expect(table.commitCount).toBe(1);
    // 3 files -> 3 pairs
    let n = 0;
    for (const row of table.pairs.values()) n += row.size;
    expect(n).toBe(3);
  });

  it("weights a recent commit above an old one at equal support", () => {
    const recent = countPairs([commit(["a", "b"], 0)], { now: NOW, halfLifeDays: 180 });
    const old = countPairs([commit(["a", "b"], 360)], { now: NOW, halfLifeDays: 180 });
    expect(statOf(recent)).toBeGreaterThan(statOf(old) * 3);
  });

  it("decays by exactly one half over one half-life", () => {
    const t = countPairs([commit(["a", "b"], 180)], { now: NOW, halfLifeDays: 180 });
    expect(statOf(t)).toBeCloseTo(0.5, 5);
  });

  it("tracks per-file commit counts for later PMI denominators", () => {
    const table = countPairs(
      [commit(["a", "b"], 0), commit(["a", "c"], 0)],
      { now: NOW },
    );
    const ai = table.files.indexOf("a");
    expect(table.single[ai]).toBe(2);
  });

  // The four tests above all use a single commit per pair, so `support` is
  // never observed above its initial 1: an implementation that hardcoded
  // `support: 1` and never incremented would pass every one of them, and
  // Task 3's minSupport thresholding rests entirely on that field.
  it("accumulates support and weight over every commit containing the pair", () => {
    const t = countPairs(
      [commit(["a", "b"], 0), commit(["a", "b"], 180)],
      { now: NOW, halfLifeDays: 180 },
    );
    const only = onlyCell(t);
    expect(only.stat.support).toBe(2);
    expect(only.stat.weight).toBeCloseTo(1.5, 5); // 1 (today) + 0.5 (one half-life)
  });

  // Pair ids are canonicalised i < j so that one pair occupies one cell. Drop
  // the sort and the same pair splits across (i,j) and (j,i) whenever two
  // commits list its files in opposite order, halving its support invisibly.
  it("keys a pair to one cell however the commits order its files", () => {
    const t = countPairs([commit(["b", "a"], 0), commit(["a", "b"], 0)], { now: NOW });
    const only = onlyCell(t);
    expect(only.i).toBeLessThan(only.j);
    expect([t.files[only.i], t.files[only.j]].sort()).toEqual(["a", "b"]);
    expect(only.stat.support).toBe(2);
  });

  it("counts a file once per commit even when the commit lists it twice", () => {
    const t = countPairs([commit(["a", "a", "b"], 0)], { now: NOW });
    const ai = t.files.indexOf("a");
    expect(t.single[ai]).toBe(1);
    expect(onlyCell(t).stat.support).toBe(1);
  });

  // A decayed numerator (PairStat.weight) is only usable against a decayed
  // denominator. Without these two fields the decay this task exists to
  // compute has no consumer: PMI would have to fall back to raw counts.
  it("tracks decayed denominators on the same scale as the pair weight", () => {
    const t = countPairs(
      [commit(["a", "b"], 180), commit(["a", "c"], 0)],
      { now: NOW, halfLifeDays: 180 },
    );
    const ai = t.files.indexOf("a");
    const bi = t.files.indexOf("b");

    expect(t.weightTotal).toBeCloseTo(1.5, 5); // 0.5 + 1
    expect(t.singleWeight).toHaveLength(t.files.length);
    expect(t.singleWeight[ai]).toBeCloseTo(1.5, 5); // in both commits
    expect(t.singleWeight[bi]).toBeCloseTo(0.5, 5); // only the old one
    expect(t.single[ai]).toBe(2); // raw counts still available

    // p(i,j) <= p(i) must hold in the decayed units too, or nPMI leaves [-1, 1].
    for (const { i, j, stat } of cells(t)) {
      expect(stat.weight).toBeLessThanOrEqual((t.singleWeight[i] ?? 0) + 1e-9);
      expect(stat.weight).toBeLessThanOrEqual((t.singleWeight[j] ?? 0) + 1e-9);
    }
  });

  // halfLifeDays 0 makes lambda Infinity, and Infinity * 0 is NaN, so a
  // same-day commit used to weigh NaN; a negative half-life made a 360-day-old
  // commit weigh 4. Both produced a plausible-looking, wrong artifact.
  it.each([0, -180, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects halfLifeDays %p instead of emitting NaN or inverted weights",
    (halfLifeDays) => {
      expect(() => countPairs([commit(["a", "b"], 0)], { now: NOW, halfLifeDays })).toThrow(
        /halfLifeDays/,
      );
    },
  );

  it("rejects a non-finite now", () => {
    expect(() => countPairs([commit(["a", "b"], 0)], { now: Number.NaN })).toThrow(/now/);
  });

  it("rejects a commit whose timestamp is not finite", () => {
    const bad: Commit = { sha: "deadbeef", files: ["a", "b"], timestamp: Number.NaN };
    expect(() => countPairs([bad], { now: NOW })).toThrow(/deadbeef/);
  });
});

interface Cell {
  i: number;
  j: number;
  stat: PairStat;
}

function cells(t: ReturnType<typeof countPairs>): Cell[] {
  const out: Cell[] = [];
  for (const [i, row] of t.pairs) for (const [j, stat] of row) out.push({ i, j, stat });
  return out;
}

function onlyCell(t: ReturnType<typeof countPairs>): Cell {
  const all = cells(t);
  expect(all).toHaveLength(1);
  const first = all[0];
  if (!first) throw new Error("expected exactly one pair");
  return first;
}

function statOf(t: ReturnType<typeof countPairs>): number {
  const all = cells(t);
  const first = all[0];
  if (!first) throw new Error("expected a pair");
  return first.stat.weight;
}
