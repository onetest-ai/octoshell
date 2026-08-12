import { describe, expect, it } from "vitest";
import { drift } from "../src/drift.js";
import type { Edge } from "../src/weights.js";
import type { Spine } from "../src/spine.js";

const files = [
  "package.json",
  "pnpm-lock.yaml",
  "svc/a/client.ts",
  "svc/a/client.test.ts",
  "svc/b/api.ts",
];

const spine: Spine = {
  source: "manifests",
  modules: ["svc/a", "svc/b", "."],
  moduleOf: (p) => (p.includes("/") ? p.split("/").slice(0, 2).join("/") : "."),
  imports: [],
};

const edge = (a: number, b: number, npmi: number): Edge => ({
  a,
  b,
  support: 8,
  npmi,
  confidence: 0.7,
});

describe("drift", () => {
  const edges = [
    edge(0, 1, 1.0), // manifest <-> lockfile — mechanical, must not surface
    edge(2, 3, 0.95), // client <-> its test  — test-subject, must not surface
    edge(2, 4, 0.85), // client <-> other service's api — THE finding
  ];

  it("surfaces the cross-boundary pair", () => {
    expect(drift(edges, files, spine)[0]?.a).toBe("svc/a/client.ts");
    expect(drift(edges, files, spine)[0]?.b).toBe("svc/b/api.ts");
  });

  it("excludes mechanical and test pairs even at higher nPMI", () => {
    const paths = drift(edges, files, spine).flatMap((r) => [r.a, r.b]);
    expect(paths).not.toContain("pnpm-lock.yaml");
    expect(paths).not.toContain("svc/a/client.test.ts");
  });

  it("excludes pairs the declared spine already relates", () => {
    const withImport: Spine = {
      ...spine,
      imports: [{ from: "svc/a", to: "svc/b", weight: 1 }],
    };
    expect(drift(edges, files, withImport)).toHaveLength(0);
  });

  it("excludes intra-module pairs", () => {
    const intraFiles = ["svc/a/client.ts", "svc/a/other.ts"];
    const intraEdges = [edge(0, 1, 0.9)];
    expect(drift(intraEdges, intraFiles, spine)).toHaveLength(0);
  });

  it("honours the limit", () => {
    expect(drift(edges, files, spine, 0)).toHaveLength(0);
  });

  /**
   * The regression this test exists for: `limit` went to `slice` raw, so a
   * negative value dropped the LAST row and returned the rest — a truncated
   * ranking presented as a complete one, which is the worse of the two failure
   * modes (returning nothing at least looks wrong). `drift` is exported from
   * index.ts and a CLI `--limit` will feed it, where "-1 means unlimited" is a
   * common enough convention that the value arrives sooner or later.
   */
  it("returns nothing rather than a silently truncated ranking on a negative limit", () => {
    const paths = ["svc/a/one.ts", "svc/b/two.ts", "svc/a/three.ts", "svc/b/four.ts"];
    const two = [edge(0, 1, 0.9), edge(2, 3, 0.8)];
    expect(drift(two, paths, spine)).toHaveLength(2); // the un-limited baseline
    expect(drift(two, paths, spine, -1)).toHaveLength(0);
  });

  /**
   * The regression this test exists for: the declared-pair lookup joined two
   * module names into one string with a printable separator ("->"), so a
   * declared edge `a -> b->c` and the candidate pair (`a->b`, `c`) produced the
   * SAME key and the candidate was dropped as "already declared". A module name
   * is a repo-relative path fragment and can hold any byte a POSIX path can, so
   * no printable separator is safe; the lookup is now nested and never builds a
   * composite key at all.
   *
   * `svc/a->b` is a legal directory name. It is a ridiculous one — which is the
   * point: the collision is invisible in every ordinary repo and silently
   * suppresses the one finding `drift` exists to report in the repo that has it.
   */
  it("does not confuse a declared pair with a candidate whose names contain the separator", () => {
    const odd: Spine = {
      source: "graphify",
      modules: ["svc/a", "svc/b->c", "svc/a->b", "svc/c"],
      moduleOf: (p) => p.split("/").slice(0, 2).join("/"),
      // Declares svc/a <-> svc/b->c. Says NOTHING about svc/a->b <-> svc/c.
      imports: [{ from: "svc/a", to: "svc/b->c", weight: 1 }],
    };
    const oddFiles = ["svc/a->b/one.ts", "svc/c/two.ts"];
    const rows = drift([edge(0, 1, 0.9)], oddFiles, odd);
    expect(rows.map((r) => [r.moduleA, r.moduleB])).toEqual([["svc/a->b", "svc/c"]]);
  });

  /**
   * `drift` reads weight through `edgeWeight`, which floors `Edge.npmi` at
   * zero, because a negative nPMI is evidence the two files co-change LESS than
   * chance — evidence of SEPARATION. Ranking that as drift would report "these
   * two are coupled" from the data that says they are not, which is the defect
   * class that put negative-weight module edges into a committed artifact in M1
   * (see weights.ts). The docstring claims this; nothing asserted it.
   */
  it("never ranks a negatively-correlated pair, whose evidence is of separation", () => {
    const paths = ["svc/a/x.ts", "svc/b/y.ts"];
    expect(drift([edge(0, 1, -0.9)], paths, spine)).toHaveLength(0);
    expect(drift([edge(0, 1, 0)], paths, spine)).toHaveLength(0);
    expect(drift([edge(0, 1, Number.NaN)], paths, spine)).toHaveLength(0);
  });

  /**
   * The regression this test exists for: a row's endpoints were emitted in
   * `Edge.a`/`Edge.b` order — i.e. in FILE ID order. Ids are assigned by first
   * appearance in `git log` output, which git emits newest commit first, so
   * committing anything that touches only `svc/b/api.ts` renumbers it below
   * `svc/a/client.ts` and the drift row flips to `api.ts <-> client.ts` on the
   * next run. Both orientations state the same true fact about an undirected
   * co-change pair, which is exactly why the churn survives review — and
   * `drift`'s output is a committed artifact, where churn with no semantic
   * change is the whole failure mode.
   *
   * `rollUp` already orders a module edge's endpoints before keying it, for
   * the same reason. This pins the file-level half of that rule.
   *
   * The two arrays below are the SAME repo with `svc/b/api.ts` renumbered
   * ahead of `svc/a/client.ts`; the emitted row must be byte-identical.
   */
  it("emits endpoints in a canonical order, not in git-log file-id order", () => {
    const forward = ["svc/a/client.ts", "svc/b/api.ts"];
    const reversed = ["svc/b/api.ts", "svc/a/client.ts"];
    const rows = drift([edge(0, 1, 0.85)], forward, spine);
    const flipped = drift([edge(0, 1, 0.85)], reversed, spine);

    expect(rows[0]?.a).toBe("svc/a/client.ts");
    expect(rows[0]?.b).toBe("svc/b/api.ts");
    // moduleA/moduleB must follow their own path, not stay pinned to the ids.
    expect(rows[0]?.moduleA).toBe("svc/a");
    expect(rows[0]?.moduleB).toBe("svc/b");
    expect(flipped).toEqual(rows);
  });

  /**
   * The ranking's tie-break reads `row.a`/`row.b`, so an id-ordered endpoint
   * reorders equal-weight ROWS too, not just the columns within one row.
   */
  it("ranks equal-weight rows identically however the file ids are numbered", () => {
    const paths = ["svc/a/one.ts", "svc/b/two.ts", "svc/a/three.ts", "svc/b/four.ts"];
    const same = drift([edge(0, 1, 0.5), edge(2, 3, 0.5)], paths, spine);
    // Same two pairs, endpoints presented to `drift` the other way round.
    const swapped = drift([edge(1, 0, 0.5), edge(3, 2, 0.5)], paths, spine);
    expect(swapped).toEqual(same);
    expect(same.map((r) => `${r.a} ${r.b}`)).toEqual([
      "svc/a/one.ts svc/b/two.ts",
      "svc/a/three.ts svc/b/four.ts",
    ]);
  });

  it("ignores a synthetic bridge edge (support 0), which carries no evidence", () => {
    const bridge: Edge = { ...edge(2, 4, 0.99), support: 0 };
    // The bridge duplicates the real finding's endpoints but carries no support,
    // so it must not produce a second row or otherwise perturb the result.
    expect(drift([...edges, bridge], files, spine)).toHaveLength(1);
  });
});
