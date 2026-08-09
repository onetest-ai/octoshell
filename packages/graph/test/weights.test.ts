import { describe, expect, it } from "vitest";
import { countPairs } from "../src/cochange.js";
import { weighEdges } from "../src/weights.js";
import type { Commit } from "../src/types.js";

const NOW = Date.UTC(2026, 0, 1);
const c = (files: string[]): Commit => ({ sha: "s", files, timestamp: NOW });

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
    const edges = weighEdges(countPairs(commits, { now: NOW }), { minSupport: 2 });
    const byKey = (a: string, b: string) => {
      const t = countPairs(commits, { now: NOW });
      const ai = t.files.indexOf(a);
      const bi = t.files.indexOf(b);
      return edges.find(
        (e) => (e.a === ai && e.b === bi) || (e.a === bi && e.b === ai),
      );
    };
    const xy = byKey("x", "y");
    const lockX = byKey("lock", "x");
    expect(xy).toBeDefined();
    expect(lockX).toBeDefined();
    expect(xy!.npmi).toBeGreaterThan(lockX!.npmi);
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
});
