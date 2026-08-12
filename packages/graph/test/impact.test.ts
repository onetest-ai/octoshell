import { describe, expect, it } from "vitest";
import { countPairs } from "../src/cochange.js";
import { impact } from "../src/impact.js";
import type { Commit } from "../src/types.js";
import { weighEdges, type Edge } from "../src/weights.js";

const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
const edges: Edge[] = [
  { a: 0, b: 1, support: 9, npmi: 0.9, confidence: 0.9 },
  { a: 0, b: 2, support: 4, npmi: 0.4, confidence: 0.4 },
  { a: 2, b: 3, support: 8, npmi: 0.8, confidence: 0.8 },
];

const NOW = Date.UTC(2026, 0, 1);
const c = (paths: string[]): Commit => ({ sha: "s", files: paths, timestamp: NOW });

/** `a` and `b` are both busy files that hardly ever move together: they share
 *  one commit where independence predicts several, so `weighEdges` scores the
 *  pair BELOW chance. Built through the real engine rather than by hand-writing
 *  a negative `npmi`, so the test also proves such an edge is something the
 *  engine actually emits — a guard against input no value can reach is a guard
 *  that does nothing. */
const ANTI_CORRELATED: Commit[] = [
  c(["a", "x"]),
  c(["a", "x"]),
  c(["a", "m1"]),
  c(["a", "m2"]),
  c(["b", "n1"]),
  c(["b", "n2"]),
  c(["b", "n3"]),
  c(["a", "b"]),
];

describe("impact", () => {
  it("returns coupled files ranked by nPMI", () => {
    const rows = impact("a.ts", edges, files);
    expect(rows.map((r) => r.path)).toEqual(["b.ts", "c.ts"]);
  });

  it("follows edges in either direction", () => {
    expect(impact("d.ts", edges, files).map((r) => r.path)).toEqual(["c.ts"]);
  });

  it("returns an empty list for an unknown path rather than throwing", () => {
    expect(impact("nope.ts", edges, files)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(impact("a.ts", edges, files, 1)).toHaveLength(1);
  });

  it("reports each row's own weight, support and confidence", () => {
    // Every other assertion here reads `.path` only, so an implementation that
    // zeroed these three, or swapped `support` with `confidence`, would pass
    // the whole file while shipping wrong numbers to whoever reads the report.
    expect(impact("a.ts", edges, files)).toEqual([
      { path: "b.ts", npmi: 0.9, support: 9, confidence: 0.9 },
      { path: "c.ts", npmi: 0.4, support: 4, confidence: 0.4 },
    ]);
  });

  it("ranks before it truncates", () => {
    // Fed weakest-first, so truncating the matches before ranking them would
    // return `c.ts` — the length assertion above cannot tell the two apart.
    const weakestFirst = [...edges].reverse();
    expect(impact("a.ts", weakestFirst, files, 1).map((r) => r.path)).toEqual(["b.ts"]);
  });

  it("orders equally weighted rows by path, whatever order the edges arrive in", () => {
    // Ties are the only place input order can leak into output: `Array#sort` is
    // stable, so dropping the path tie-break still passes every ranking test
    // above and silently makes the result a function of how `weighEdges`
    // happened to emit its list. This output is a committed artifact.
    const tied: Edge[] = [
      { a: 0, b: 3, support: 5, npmi: 0.5, confidence: 0.5 },
      { a: 0, b: 1, support: 5, npmi: 0.5, confidence: 0.5 },
      { a: 2, b: 0, support: 5, npmi: 0.5, confidence: 0.5 },
    ];
    const expected = ["b.ts", "c.ts", "d.ts"];
    expect(impact("a.ts", tied, files).map((r) => r.path)).toEqual(expected);
    expect(impact("a.ts", [...tied].reverse(), files).map((r) => r.path)).toEqual(expected);
  });

  it("never reports a pair that co-changes less than chance as impact", () => {
    const table = countPairs(ANTI_CORRELATED, { now: NOW });
    const engineEdges = weighEdges(table, { minSupport: 1 });
    const ai = table.files.indexOf("a");
    const bi = table.files.indexOf("b");
    const ab = engineEdges.find(
      (e) => (e.a === ai && e.b === bi) || (e.a === bi && e.b === ai),
    );
    // The fixture is only meaningful while the engine still scores this pair
    // below chance; assert that before asserting what `impact` does with it.
    expect(ab?.npmi).toBeLessThan(0);

    const rows = impact("a", engineEdges, table.files).map((r) => r.path);
    expect(rows).not.toContain("b");
    expect(rows).toContain("x");
  });
});
