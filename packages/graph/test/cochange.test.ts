import { describe, expect, it } from "vitest";
import { countPairs } from "../src/cochange.js";
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
});

function statOf(t: ReturnType<typeof countPairs>): number {
  const row = [...t.pairs.values()][0];
  const stat = row ? [...row.values()][0] : undefined;
  if (!stat) throw new Error("expected a pair");
  return stat.weight;
}
