import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingSets } from "../src/working-sets.js";
import { analyze } from "../src/analyze.js";
import { bridgeComponents } from "../src/components.js";
import { louvain } from "../src/louvain.js";
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

/**
 * A SYNTHETIC bridge, exactly as `bridgeComponents` mints one: `support: 0`
 * (no commit backs it) at `BRIDGE_WEIGHT`. Present in `bridgedEdges` — the
 * edge set `workingSets` is required to read — and evidence of nothing.
 */
const bridge = (a: number, b: number): Edge => ({ a, b, support: 0, npmi: 0.01, confidence: 0 });

describe("workingSets", () => {
  it("drops a community whose files all fall inside one declared module", () => {
    const files = ["a/one.ts", "a/two.ts", "a/three.ts"];
    const byCommunity = new Map([[7, [0, 1, 2]]]);
    expect(workingSets(byCommunity, [], files, moduleOf)).toEqual([]);
  });

  it("keeps a community spanning two declared modules and names the span", () => {
    const files = ["a/one.ts", "b/two.ts"];
    const byCommunity = new Map([[7, [0, 1]]]);
    // The real co-change edge that put these two in one community. Passing
    // `[]` here would assert a cross-module span with no observation behind
    // it — the thing the span check exists to refuse.
    const [set] = workingSets(byCommunity, [edge(0, 1)], files, moduleOf);
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
    const edges = [edge(0, 1), edge(1, 2)];
    expect(workingSets(new Map([[9, [0, 1, 2]]]), edges, files, mod)).toHaveLength(1);
  });

  /**
   * The regression this whole file existed to make impossible and did not:
   * a rendered claim with nothing behind it.
   *
   * `bridgeComponents` mints a `support: 0` edge to stop Louvain emitting a
   * junk community per connected component. It is backed by NO commit —
   * `rollUp` refuses the bridged edge set wholesale for exactly that reason,
   * and `drift` skips it per edge. `workingSets` MUST read `bridgedEdges`
   * (that is the graph the partition came from), so it is the one consumer
   * that can mistake a bridge for evidence, and it did: two files joined by
   * nothing but a bridge rendered as "2 files across a, b" under a note
   * reading "Observed from commit history".
   *
   * Every other fixture in this file uses edges at nPMI 0.9, so none of them
   * could ever exhibit it.
   */
  it("does not report a set whose only cross-module link is a synthetic bridge", () => {
    const files = ["a/one.ts", "b/one.ts"];
    expect(workingSets(new Map([[3, [0, 1]]]), [bridge(0, 1)], files, moduleOf)).toEqual([]);
  });

  /**
   * The same rule where it actually bites: a set that IS backed by real
   * co-change across one boundary, but names a third module attached to it by
   * a bridge alone. The span claim is per-module, so the whole set goes — its
   * `files` are documented as exactly the community's membership, and a
   * narrowed span above an unnarrowed file list is the same lie, quieter.
   */
  it("does not report a set that names a third module only a synthetic bridge reaches", () => {
    const files = ["a/one.ts", "b/one.ts", "c/one.ts"];
    const mod = (p: string): string => p.split("/")[0] ?? "root";
    const edges = [edge(0, 1), bridge(1, 2)];
    expect(workingSets(new Map([[3, [0, 1, 2]]]), edges, files, mod)).toEqual([]);
    // …and the same community minus the bridged member is still reported, so
    // the rule is scoped to the unbacked span and not to bridges in general.
    expect(workingSets(new Map([[3, [0, 1]]]), edges, files, mod)).toHaveLength(1);
  });

  /**
   * An edge with a non-positive nPMI is evidence of SEPARATION — every other
   * consumer in this package reads weight through `edgeWeight` so such a pair
   * never counts as coupling (weights.ts, and `conventions.test.ts`'s npmi
   * guard). A span held up by one of those is as unbacked as a bridged one.
   */
  it("does not count a non-positively-correlated pair as evidence of a span", () => {
    const files = ["a/one.ts", "b/one.ts"];
    const anti: Edge = { a: 0, b: 1, support: 5, npmi: -0.4, confidence: 0.2 };
    expect(workingSets(new Map([[3, [0, 1]]]), [anti], files, moduleOf)).toEqual([]);
  });

  /**
   * Reachability, through the real `bridgeComponents` + `louvain` rather than
   * a hand-written bridge: `BRIDGE_WEIGHT` is 0.01, documented as "enough to
   * connect, too little to cluster" — which holds only while the real edges
   * around it are stronger than that. nPMI is normalised to [-1, 1] and a pair
   * co-changing at almost exactly chance scores just above zero, so a repo
   * with weak-but-repeated pairings lets the bridge win modularity outright.
   *
   * Two components, one wholly inside module `a` and one wholly inside `b`,
   * at nPMI 0.001: Louvain merges the two bridge endpoints into a community of
   * their own. Neither component crosses a boundary on its own, and no commit
   * in the fixture touches an `a/` file and a `b/` file together — so the only
   * boundary-crossing community here is the one the clustering aid invented.
   */
  it("reports nothing when the bridge outweighs real co-change and invents a cross-module community", () => {
    const files = ["a/one.ts", "a/two.ts", "a/three.ts", "b/one.ts", "b/two.ts", "b/three.ts"];
    const weak = (a: number, b: number): Edge => ({ a, b, support: 2, npmi: 0.001, confidence: 0.5 });
    const real = [weak(0, 1), weak(1, 2), weak(0, 2), weak(3, 4), weak(4, 5), weak(3, 5)];

    const bridged = bridgeComponents(real, files);
    // Precondition: a bridge really was minted, and Louvain really did merge
    // across it. Without this the assertion below passes for a partition that
    // never crossed a boundary at all.
    expect(bridged.length).toBeGreaterThan(real.length);
    const partition = louvain(bridged, { exclude: new Set<number>() });
    const byCommunity = new Map<number, number[]>();
    for (const [node, comm] of partition) {
      const list = byCommunity.get(comm);
      if (list) list.push(node);
      else byCommunity.set(comm, [node]);
    }
    const spans = [...byCommunity.values()].filter(
      (m) => new Set(m.map((n) => moduleOf(files[n] ?? ""))).size > 1,
    );
    expect(spans.length).toBeGreaterThan(0);

    expect(workingSets(byCommunity, bridged, files, moduleOf)).toEqual([]);
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
    const [set] = workingSets(new Map([[7, [0, 1]]]), [edge(0, 1)], files, mod);
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
    // Real co-change inside each community, crossing the a/b boundary in both.
    const edges = [edge(0, 1), edge(2, 3), edge(3, 4)];

    const first = workingSets(forward, edges, files, moduleOf);
    expect(workingSets(forward, edges, files, moduleOf)).toEqual(first);
    expect(workingSets(reversed, edges, files, moduleOf)).toEqual(first);
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
  // RE-ANCHORED 2026-08-12, and the reason matters more than the change.
  //
  // This test used to assert a SPECIFIC working set on this repo's history:
  // that the set containing `packages/board/src/entity-schema.ts` also held
  // the pack's `entity-io.mjs` and spanned exactly two declared modules. That
  // held on the campaign branch and fails on `main`, because the campaign was
  // SQUASH-merged: 102 commits across seven missions became one commit
  // touching 147 files, which then exceeds `maxCommitFiles` and is dropped
  // entirely. `harvest()` sees 21 analysable commits on `main` where the
  // branch had 84, and a Louvain community that needed intra-branch
  // co-change simply does not form.
  //
  // That is a real product defect, filed as `squash-merged PRs destroy the
  // co-change signal`, NOT a reason to weaken the test into a fixture. The
  // M7 plan said if this ever broke, the fix was to re-measure and decide.
  // Re-measured: the founding pair's COUPLING survives squashing (it also
  // co-changes outside the squashed commit — `drift` ranks it 4 and `impact`
  // ranks it 3 on `main` today); the COMMUNITY containing it does not.
  //
  // So this now asserts the durable half against real history, and the
  // structural invariant that no fixture can fake. If the squash defect is
  // ever fixed, restore the membership assertion — do not delete this note.
  it("computes well-formed boundary-crossing sets from this repo's real history", () => {
    // `minCommits: 1` pins thin-history suppression off. `analyze()` returns
    // `workingSets: []` whenever this repo's analysable commit count is below
    // `config.minCommits` (default 200, comfortably above what this repo has),
    // and that policy is not what this test verifies. Suppression has its own
    // tests where it's implemented; do not "simplify" this back to the default
    // config, or this test silently starts asserting against an empty array.
    const config = { ...loadConfig(REPO_ROOT, {}), minCommits: 1 };
    const { analysis } = analyze(REPO_ROOT, config, { now: NOW });

    // The anti-fabrication anchor: real history must produce real sets, and
    // every one of them must genuinely earn the claim its heading makes.
    expect(analysis.workingSets.length).toBeGreaterThan(0);
    // Annotated through the PUBLIC `WorkingSet` type on purpose: a consumer
    // outside this package needs the type as much as the function, and an
    // index.ts that exports one without the other is unusable. The deep
    // import above cannot prove that; this can.
    for (const set of analysis.workingSets satisfies WorkingSet[]) {
      expect(new Set(set.modules).size).toBeGreaterThanOrEqual(2);
      expect(set.files.length).toBeGreaterThanOrEqual(set.modules.length);
      // The name is a member path, never a module name — see working-sets.ts.
      expect(set.files).toContain(set.name);
    }
  });

  it("still sees the dual-schema coupling in this repo's real history", () => {
    // The campaign's founding example: two files implementing one schema with
    // no import edge possible, because the pack script is deliberately
    // dependency-free. This is the claim octograph exists to support, so it is
    // asserted against live history rather than a fixture — and unlike the
    // community above, it survives a squashed merge.
    const config = { ...loadConfig(REPO_ROOT, {}), minCommits: 1 };
    const { edges, files } = analyze(REPO_ROOT, config, { now: NOW });
    const idOf = (suffix: string): number => files.findIndex((f) => f.endsWith(suffix));
    const schema = idOf("packages/board/src/entity-schema.ts");
    const io = idOf("mission-planner/scripts/entity-io.mjs");
    expect(schema).toBeGreaterThanOrEqual(0);
    expect(io).toBeGreaterThanOrEqual(0);
    const edge = edges.find(
      (e) => (e.a === schema && e.b === io) || (e.a === io && e.b === schema),
    );
    expect(edge, "the dual-schema pair must still co-change in real history").toBeDefined();
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
