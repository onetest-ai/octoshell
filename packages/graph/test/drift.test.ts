import { describe, expect, it } from "vitest";
import { drift } from "../src/drift.js";
import type { Edge } from "../src/weights.js";
import type { Spine } from "../src/spine.js";
import type { VaultNote } from "../src/vault.js";

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

  /**
   * The regression this test exists for: `drift` ranked by nPMI alone, so a
   * pair seen exactly `minSupport` times at the maximum nPMI (1.0) outranked
   * a pair with far more repeated evidence and a moderately lower nPMI —
   * confirmed on octoweb (1,784 commits), where the pair with the HIGHEST
   * support in the whole result (9) ranked 18th of 20. See
   * `.octobots/campaigns/octograph-code-architecture-graph/bugs/
   * drift-ranks-a-pair-seen-twice-above-a-pair-seen-ni/` and `rank.ts`.
   *
   * Shaped after the real octoweb finding: `coincidence` mirrors the
   * two-observation pairs that dominated the old top 10 (nPMI 1.0, support
   * 2 — the admission floor); `repeatedCoupling` mirrors the buried finding
   * (nPMI 0.873, support 9). Both are undeclared, cross-module, non-noise
   * pairs, so nothing but the ranking decides their order.
   */
  it("ranks a pair with repeated real evidence above a two-observation coincidence at the maximum nPMI", () => {
    const pairFiles = [
      "modA/coincidence-x.ts",
      "modB/coincidence-y.ts",
      "modC/repeated-x.ts",
      "modD/repeated-y.ts",
    ];
    const pairSpine: Spine = {
      source: "manifests",
      modules: ["modA", "modB", "modC", "modD"],
      moduleOf: (p) => p.split("/")[0] ?? p,
      imports: [],
    };
    const coincidence: Edge = { a: 0, b: 1, support: 2, npmi: 1.0, confidence: 1.0 };
    const repeatedCoupling: Edge = { a: 2, b: 3, support: 9, npmi: 0.873, confidence: 0.707 };

    const rows = drift([coincidence, repeatedCoupling], pairFiles, pairSpine);
    expect(rows.map((r) => r.support)).toEqual([9, 2]);
    expect(rows[0]?.a).toBe("modC/repeated-x.ts");
    expect(rows[0]?.b).toBe("modD/repeated-y.ts");
  });

  /**
   * The regression this test exists for: `drift` ranked a `.agents/`
   * daily-log path against real source at the same nPMI as any other
   * candidate pair. Confirmed on octoweb: 5 of the top 10 rows named an
   * `.agents/` or `.claude/` path — this tool's own working notes, not the
   * codebase under analysis (see `isExcludedPath`'s doc comment, noise.ts).
   * `excludePaths` defaults to `[]` here (drift.ts), so this behaviour is
   * opt-in per call — `cli.ts` is the one caller that feeds it
   * `config.excludePaths`.
   */
});

describe("vault marking", () => {
  // `edges`, `files` and `spine` are the file-level fixtures: drift's top row
  // is svc/a/client.ts <-> svc/b/api.ts, the cross-boundary finding.
  const driftEdges = [edge(0, 1, 1.0), edge(2, 3, 0.95), edge(2, 4, 0.85)];

  const note = (name: string, body: string): VaultNote => ({
    note: `architecture/${name}.md`,
    name,
    description: `${name} description`,
    verified: "2026-08-13",
    body,
  });

  it("marks a pair one note cites both halves of", () => {
    const notes = [note("pair", "the pair is svc/a/client.ts and svc/b/api.ts")];
    const rows = drift(driftEdges, files, spine, 20, 2, notes);
    expect(rows[0]?.a).toBe("svc/a/client.ts");
    expect(rows[0]?.known).toBe("architecture/pair.md");
  });

  it("does not mark a pair whose halves are cited by DIFFERENT notes", () => {
    // The claim is about the PAIR. Two notes each describing one file are not
    // a record that the two are coupled — which is the whole finding.
    const notes = [
      note("left", "svc/a/client.ts alone"),
      note("right", "svc/b/api.ts alone"),
    ];
    expect(drift(driftEdges, files, spine, 20, 2, notes)[0]?.known).toBeNull();
  });

  it("does not mark on a bare basename", () => {
    const notes = [note("loose", "client.ts and api.ts")];
    expect(drift(driftEdges, files, spine, 20, 2, notes)[0]?.known).toBeNull();
  });

  it("leaves known null when no notes are supplied", () => {
    expect(drift(driftEdges, files, spine)[0]?.known).toBeNull();
  });

  /**
   * The regression this test exists for: when two notes both cite the same
   * pair, the winner was whichever happened to come FIRST in the caller's
   * `notes` array — an ordering `drift` does not control (`readVault` sorts
   * its own output, but `drift` is a public export a caller can feed
   * directly). `known` must resolve to the same note however the caller
   * ordered its list, the same determinism `scored.sort`'s tie-break already
   * guarantees for row order.
   */
  it("resolves to the same note regardless of the caller's note ordering", () => {
    const zzz = note("zzz-later", "svc/a/client.ts and svc/b/api.ts");
    const aaa = note("aaa-earlier", "svc/a/client.ts and svc/b/api.ts");
    const forward = drift(driftEdges, files, spine, 20, 2, [zzz, aaa]);
    const reversed = drift(driftEdges, files, spine, 20, 2, [aaa, zzz]);
    expect(forward[0]?.known).toBe("architecture/aaa-earlier.md");
    expect(reversed[0]?.known).toBe("architecture/aaa-earlier.md");
  });
});
