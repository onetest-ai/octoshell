import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingSets } from "../src/working-sets.js";
import { analyze } from "../src/analyze.js";
import { loadConfig } from "../src/config.js";
// Imported through the package's PUBLIC entry point on purpose, alongside the
// deep `../src/working-sets.js` import above: a cross-package consumer reads
// `dist/index.js` and nothing else, so a symbol index.ts does not re-export
// does not exist outside this package however complete it is (see
// conventions.test.ts, which guards the same rule at source level).
import { workingSets as publicWorkingSets, type WorkingSet } from "../src/index.js";
import type { Edge } from "../src/weights.js";

const moduleOf = (p: string): string => (p.startsWith("a/") ? "a" : p.startsWith("b/") ? "b" : "root");

// packages/graph/test -> packages/graph -> packages -> repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A pinned epoch, exactly as every other suite in this package pins one.
 *
 * `analyze`'s `now` feeds `countPairs`'s exponential decay, so a wall-clock
 * `Date.now()` here would measure this repo's history from a different point
 * on every run: the edge weights, and therefore the Louvain partition and the
 * working sets read off it, would be a function of when the test happened to
 * execute. `analyze` takes `now` as a required parameter precisely so a caller
 * cannot do that (see cli.ts's note on the same option).
 */
const NOW = Date.UTC(2026, 0, 1);

/** A co-change edge strong enough to carry PageRank mass. */
const edge = (a: number, b: number): Edge => ({ a, b, support: 3, npmi: 0.9, confidence: 0.9 });

describe("workingSets", () => {
  it("drops a community whose files all fall inside one declared module", () => {
    const files = ["a/one.ts", "a/two.ts", "a/three.ts"];
    const byCommunity = new Map([[7, [0, 1, 2]]]);
    expect(workingSets(byCommunity, [], files, moduleOf)).toEqual([]);
  });

  it("keeps a community spanning two declared modules and names the span", () => {
    const files = ["a/one.ts", "b/two.ts"];
    const byCommunity = new Map([[7, [0, 1]]]);
    const [set] = workingSets(byCommunity, [], files, moduleOf);
    expect(set?.modules).toEqual(["a", "b"]);
    expect(set?.files).toEqual(["a/one.ts", "b/two.ts"]);
  });

  it("drops a two-file set that is entirely a manifest/lockfile pair", () => {
    const files = ["packages/graph/package.json", "pnpm-lock.yaml"];
    const mod = (p: string): string => (p.includes("/") ? "packages/graph" : "(repo root)");
    expect(workingSets(new Map([[24, [0, 1]]]), [], files, mod)).toEqual([]);
  });

  it("keeps a larger set that merely contains a lockfile", () => {
    const files = ["a/x.ts", "b/y.ts", "pnpm-lock.yaml"];
    const mod = (p: string): string => (p.startsWith("a/") ? "a" : p.startsWith("b/") ? "b" : "root");
    expect(workingSets(new Map([[9, [0, 1, 2]]]), [], files, mod)).toHaveLength(1);
  });

  /**
   * Criterion 3, and the campaign's recurring defect in miniature: `name` is
   * documented as "its most central member's file path — a path, never a module
   * name", and nothing asserted either half. `nameCluster` returns PATHS, so an
   * implementation that indexed `files[]` with the result a second time — or one
   * that ran the result through `spine.moduleOf`, as `analyze` does for its
   * module headings — would still produce a plausible-looking `WorkingSet` and
   * still pass every other test in this file.
   *
   * The graph is a star: `a/hub.ts` is the only node the other two touch, so it
   * carries strictly the most PageRank and is unambiguously "most central" —
   * unlike the edgeless fixtures above, where every member ties and the name
   * falls out of the id tie-break rather than out of centrality.
   */
  it("names a set after its most central MEMBER PATH, not a module and not the first path", () => {
    const files = ["z/hub.ts", "a/leaf.ts", "b/leaf.ts"];
    const mod = (p: string): string => p.split("/")[0] ?? "root";
    const edges = [edge(0, 1), edge(0, 2)];
    const [set] = workingSets(new Map([[3, [0, 1, 2]]]), edges, files, mod);

    expect(set?.name).toBe("z/hub.ts");
    // A path, never a module name — the two are distinguishable here because
    // no module in this fixture is spelled the same as any file.
    expect(set?.modules).not.toContain(set?.name);
    // And always a member of the set it names: a name outside `files` is the
    // dangling heading A5c's "name is a path" rule exists to prevent.
    expect(set?.files).toContain(set?.name);
    // Not simply `files[0]` nor `paths[0]` — both of which would be
    // "a/leaf.ts" here — so a fallback silently standing in for the
    // centrality computation cannot pass.
    expect(set?.files[0]).toBe("a/leaf.ts");
  });

  /**
   * Criterion 1's ordering half. Both fixtures above already arrive sorted, so
   * they pass whether or not `modules` and `files` are ordered at all; this one
   * arrives in the reverse of the required order in both fields at once.
   */
  it("orders modules and files by compare, not by the order they were encountered", () => {
    const files = ["z/two.ts", "a/one.ts"];
    const mod = (p: string): string => p.split("/")[0] ?? "root";
    const [set] = workingSets(new Map([[7, [0, 1]]]), [], files, mod);
    expect(set?.modules).toEqual(["a", "z"]);
    expect(set?.files).toEqual(["a/one.ts", "z/two.ts"]);
  });

  /**
   * Criterion 6. `workingSets` output reaches map.md, a COMMITTED artifact, so
   * an order that is a property of `Map` insertion rather than of the data puts
   * churn into a file whose whole purpose is to diff cleanly.
   *
   * Both halves are asserted: the same call twice (no hidden mutable state),
   * and the same logical partition fed in through two different Map insertion
   * orders — which is the failure a single repeated call cannot see, because a
   * function that iterates `byCommunity` in insertion order returns the same
   * wrong order both times.
   */
  it("returns the same array regardless of how the input Map was filled", () => {
    const files = ["a/one.ts", "b/two.ts", "a/three.ts", "b/four.ts", "a/five.ts"];
    const forward = new Map([
      [2, [0, 1]],
      [9, [2, 3, 4]],
    ]);
    const reversed = new Map([
      [9, [2, 3, 4]],
      [2, [0, 1]],
    ]);

    const first = workingSets(forward, [], files, moduleOf);
    expect(workingSets(forward, [], files, moduleOf)).toEqual(first);
    expect(workingSets(reversed, [], files, moduleOf)).toEqual(first);
    // Descending size, so the three-file community leads regardless of which
    // community id was inserted first.
    expect(first.map((w) => w.files.length)).toEqual([3, 2]);
  });

  // Live-history assertion, deliberately: it re-checks the mission's own
  // headline claim against this repo's real commit history rather than a
  // synthetic fixture. It will drift as the repo grows — that is expected;
  // this campaign has twice shipped a claim nothing re-checked, and the fix
  // for a broken instance of this test is to re-measure and decide, not to
  // delete it.
  it("finds the dual-schema working set on this repo's own history", () => {
    // `minCommits: 1` pins thin-history suppression off. `analyze()` returns
    // `workingSets: []` whenever this repo's analysable commit count is below
    // `config.minCommits` (default 200, comfortably above what this repo has),
    // and that policy is not what this test verifies — it exists to check
    // that `workingSets()` computes the right thing from real history, not to
    // re-check the suppression threshold. Suppression has its own tests where
    // it's implemented; do not "simplify" this back to the default config, or
    // this test silently starts asserting against an empty array again.
    const config = { ...loadConfig(REPO_ROOT, {}), minCommits: 1 };
    const { analysis } = analyze(REPO_ROOT, config, { now: NOW });
    const set: WorkingSet | undefined = analysis.workingSets.find((w) =>
      w.files.includes("packages/board/src/entity-schema.ts"));
    expect(set?.files.some((f) => f.endsWith("entity-io.mjs"))).toBe(true);
    expect(set?.modules).toEqual(["apps/vscode-extension", "packages/board"]);
  });

  /**
   * Criterion 5, and every claim a `WorkingSet` makes checked against what
   * actually produced it — on this repo's real partition rather than a fixture
   * shaped to agree.
   *
   * The recurring defect this campaign ships is a rendered claim that outran
   * its computation: a `clusterIds` field pinned to a constant, a count that
   * said "21 files" while meaning something narrower, an edge naming a module
   * with no heading. `WorkingSet` introduces three new claims at once — a name,
   * a file list, a module span — and M7 renders all three into a committed
   * artifact. So each is re-derived here from the same `spine.moduleOf` the
   * producer used, never from a second hand-rolled path rule.
   */
  it("is reachable from index.ts, and every set analyze() reports states only what its files support", () => {
    // `workingSets` reached the package's public entry point. Two prior
    // missions here shipped whole subsystems that never did, and stayed green
    // throughout because every test imported them by deep path.
    expect(publicWorkingSets).toBe(workingSets);

    // Same `minCommits: 1` pin as the test above, and for the same reason:
    // this test verifies what a `WorkingSet` claims about real history, not
    // whether thin-history suppression fires. Leave it pinned below this
    // repo's analysable commit count — the default (200) is not.
    const config = { ...loadConfig(REPO_ROOT, {}), minCommits: 1 };
    const { analysis, spine } = analyze(REPO_ROOT, config, { now: NOW });
    expect(analysis.workingSets.length).toBeGreaterThan(0);

    for (const set of analysis.workingSets) {
      // The name is a member path — not a module, not a synthesised label.
      expect(set.files).toContain(set.name);
      // `modules` is exactly the modules these files resolve to: no module
      // nothing in the set lives in, and no spanned module left out.
      expect(set.modules).toEqual([...new Set(set.files.map(spine.moduleOf))].sort());
      // And a set that spans one module is not a disagreement with the spine.
      expect(set.modules.length).toBeGreaterThanOrEqual(2);
      expect([...set.files].sort()).toEqual(set.files);
    }

    // Descending by size — the ordering the artifact will read in.
    expect(analysis.workingSets.map((w) => w.files.length)).toEqual(
      [...analysis.workingSets.map((w) => w.files.length)].sort((x, y) => y - x),
    );
  });
});
