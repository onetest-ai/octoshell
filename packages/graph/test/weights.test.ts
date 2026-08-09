import { describe, expect, it } from "vitest";
import { countPairs, type PairTable } from "../src/cochange.js";
import { weighEdges, type Edge } from "../src/weights.js";
import type { Commit } from "../src/types.js";

const NOW = Date.UTC(2026, 0, 1);
const DAY = 86400000;
const c = (files: string[], daysAgo = 0): Commit => ({
  sha: "s",
  files,
  timestamp: NOW - daysAgo * DAY,
});

/** Look an edge up by path. Throws rather than returning undefined so callers
 *  never need a non-null assertion to read a field off it. */
function edgeFor(table: PairTable, edges: Edge[], a: string, b: string): Edge {
  const ai = table.files.indexOf(a);
  const bi = table.files.indexOf(b);
  const found = edges.find(
    (e) => (e.a === ai && e.b === bi) || (e.a === bi && e.b === ai),
  );
  if (!found) throw new Error(`expected an edge between ${a} and ${b}`);
  return found;
}

/** `a`/`b` pair recently, `a`/`c` paired equally often but two years ago.
 *  Raw commit counts make the two pairs perfectly symmetric, so any
 *  difference between them can only come from the recency decay. */
const AGED_HISTORY = [
  c(["a", "b"]),
  c(["a", "b"]),
  c(["a", "c"], 720),
  c(["a", "c"], 720),
  c(["a", "z"]),
  c(["p", "q"]),
];

describe("weighEdges", () => {
  it("gives a perfectly co-occurring pair an nPMI of 1", () => {
    const edges = weighEdges(countPairs([c(["a", "b"]), c(["a", "b"])], { now: NOW }), {
      minSupport: 1,
    });
    const ab = edges.find((e) => e.support === 2);
    expect(ab?.npmi).toBeCloseTo(1, 5);
  });

  it("ranks a hub pairing below a genuine pairing at equal support", () => {
    // `lock` appears in every commit (a hub); `x`/`y` only appear together.
    const commits = [
      c(["lock", "x", "y"]),
      c(["lock", "p"]),
      c(["lock", "q"]),
      c(["lock", "r"]),
      c(["lock", "x", "y"]),
    ];
    const table = countPairs(commits, { now: NOW });
    const edges = weighEdges(table, { minSupport: 2 });
    expect(edgeFor(table, edges, "x", "y").npmi).toBeGreaterThan(
      edgeFor(table, edges, "lock", "x").npmi,
    );
  });

  it("drops pairs below minSupport", () => {
    const edges = weighEdges(countPairs([c(["a", "b"])], { now: NOW }), { minSupport: 2 });
    expect(edges).toHaveLength(0);
  });

  it("reports confidence as the weaker directional share", () => {
    // a appears 3x, b appears 2x, together 2x -> min(2/3, 2/2) = 0.666…
    const edges = weighEdges(
      countPairs([c(["a", "b"]), c(["a", "b"]), c(["a", "z"])], { now: NOW }),
      { minSupport: 2 },
    );
    const ab = edges.find((e) => e.support === 2);
    expect(ab?.confidence).toBeCloseTo(2 / 3, 5);
  });

  // Weighing on raw commit counts leaves `PairStat.weight`, `singleWeight` and
  // `weightTotal` unread, which makes the decay Task 2 exists to compute a
  // no-op on every edge in the graph. These two lock the decay into the output.
  it("weighs a recent pairing above an equally-supported stale one", () => {
    const table = countPairs(AGED_HISTORY, { now: NOW, halfLifeDays: 180 });
    const edges = weighEdges(table, { minSupport: 2 });

    // Identical raw support (2) and identical raw marginals, so on undecayed
    // counts these two are numerically equal to the last bit.
    expect(edgeFor(table, edges, "a", "b").support).toBe(
      edgeFor(table, edges, "a", "c").support,
    );
    expect(edgeFor(table, edges, "a", "b").npmi).toBeGreaterThan(
      edgeFor(table, edges, "a", "c").npmi * 2,
    );
  });

  it("lets halfLifeDays change an edge's weight", () => {
    const table = countPairs(AGED_HISTORY, { now: NOW, halfLifeDays: 30 });
    const impatient = weighEdges(table, { minSupport: 2 });
    const patient = weighEdges(
      countPairs(AGED_HISTORY, { now: NOW, halfLifeDays: 3650 }),
      { minSupport: 2 },
    );
    // File ids are assigned in commit order, so the same table indexes both.
    expect(edgeFor(table, impatient, "a", "c").npmi).not.toBeCloseTo(
      edgeFor(table, patient, "a", "c").npmi,
      3,
    );
  });

  it("drops a pair whose history has decayed to zero mass instead of emitting NaN", () => {
    // At a 0.001-day half-life a year-old commit's decay factor underflows to
    // exactly 0. log(0) would put -Infinity/Infinity = NaN into `npmi`, and a
    // NaN makes the output comparator return NaN — an unordered, unstable
    // artifact — as well as landing NaN in the committed graph.
    const table = countPairs(
      [c(["a", "b"]), c(["a", "b"]), c(["old1", "old2"], 365), c(["old1", "old2"], 365)],
      { now: NOW, halfLifeDays: 0.001 },
    );
    const edges = weighEdges(table, { minSupport: 2 });

    expect(edges).toHaveLength(1);
    expect(edgeFor(table, edges, "a", "b").npmi).toBeCloseTo(1, 5);
    for (const e of edges) expect(Number.isFinite(e.npmi)).toBe(true);
  });

  it("keeps every edge inside the documented bounds across a mixed-age history", () => {
    const table = countPairs(
      [
        c(["a", "b", "c"]),
        c(["a", "b"], 45),
        c(["a", "d"], 400),
        c(["c", "d"], 900),
        c(["e", "f"], 1500),
        c(["a", "e"], 12),
      ],
      { now: NOW, halfLifeDays: 180 },
    );
    const edges = weighEdges(table, { minSupport: 1 });

    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(Number.isFinite(e.npmi)).toBe(true);
      expect(e.npmi).toBeGreaterThanOrEqual(-1);
      expect(e.npmi).toBeLessThanOrEqual(1);
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("emits the same edges in the same order on every run", () => {
    const build = (): Edge[] =>
      weighEdges(countPairs(AGED_HISTORY, { now: NOW, halfLifeDays: 180 }), {
        minSupport: 1,
      });
    expect(build()).toEqual(build());
  });
});
