import { isSyntheticBridge } from "./components.js";
import { classifyPair } from "./noise.js";
import { compare, nameCluster } from "./rollup.js";
import { edgeWeight, type Edge } from "./weights.js";

export interface WorkingSet {
  /** The set's own name: its most central member's file path. NOT a module
   *  name — a working set is precisely the thing that has no declared name. */
  name: string;
  /** Declared modules this set spans, ascending by `compare`. Always >= 2. */
  modules: string[];
  /**
   * Member file paths, ascending by `compare`.
   *
   * Exactly the Louvain community's membership — which is NOT every file that
   * co-changes with this set. `analyze` excludes hubs and test files from
   * clustering before `louvain` runs (A8, and the hub quarantine above it), so
   * a hub that churns with every member of this set is absent from it. That is
   * the honest reading of the partition and it is what a renderer may claim:
   * "these N files form one community", never "these are all the files that
   * move together". Stating the second from this field would be a claim the
   * computation does not support.
   */
  files: string[];
}

/**
 * Turn `analyze()`'s Louvain partition into the communities that DISAGREE
 * with the declared spine — the "discovered delta" half of spec D3.
 *
 * A community whose members all resolve to one declared module agrees with
 * the declared structure and states nothing new; only a community spanning
 * two or more declared modules is a working set. This changes nothing about
 * module identity or membership — those stay declared (spec A5c) — it only
 * surfaces a second, independent read of the same partition `analyze()`
 * already computed.
 *
 * `edges` MUST be `bridgedEdges` — the edge set clustering actually saw — not
 * the full weighted `edges`, so `nameCluster`'s centrality measures the same
 * graph the partition came from. It is also what the span check below reads:
 * the bridged set is the only one that contains BOTH the real evidence and the
 * synthetic edges that must not count as evidence, so both questions can be
 * answered from one argument.
 *
 * Pure: takes the partition and the spine's `moduleOf`, touches no disk.
 */
export function workingSets(
  byCommunity: Map<number, number[]>,
  edges: Edge[],
  files: string[],
  moduleOf: (path: string) => string,
): WorkingSet[] {
  const out: WorkingSet[] = [];
  // Communities are iterated by ascending id, not Map insertion order: this
  // reaches map.md, so the order must be a property of the data.
  for (const [, members] of [...byCommunity.entries()].sort((x, y) => x[0] - y[0])) {
    const paths = members
      .map((n) => files[n])
      .filter((p): p is string => p !== undefined)
      .sort(compare);
    const modules = [...new Set(paths.map(moduleOf))].sort(compare);
    if (modules.length < 2) continue; // agrees with the declared structure — not a delta

    // Every module this set names must be joined to another one by a REAL
    // co-change edge — a commit that touched a file on each side. Membership
    // is the community's, but the SPAN is the claim the section publishes
    // ("N files across a, b"), and a span is only observable if something
    // observed it.
    //
    // Two edges inside a community can fail that. A synthetic bridge
    // (`isSyntheticBridge`, components.ts) is backed by no commit at all, and
    // `bridgeComponents` weights it at 0.01 — "enough to connect, too little
    // to cluster" — which holds only while the real edges around it are
    // stronger than that. They are not always: nPMI is normalised to [-1, 1]
    // and a pair that co-changes at almost exactly chance scores just above
    // zero, so a repo with weak-but-repeated pairings lets the bridge dominate
    // modularity and Louvain merges its two endpoints into a community of
    // their own. Verified: two 3-file components, one wholly inside module `a`
    // and one wholly inside `b`, at nPMI 0.001 produce the community
    // {a/one.ts, b/one.ts} — two files that appear together in no commit,
    // rendered as "2 files across a, b". An edge whose `edgeWeight` is zero is
    // excluded for the reason it is excluded everywhere else in this package:
    // a non-positive nPMI is evidence of separation, not of coupling.
    //
    // This is the same rule `rollUp` applies by refusing the bridged edge set
    // wholesale and `drift` applies per edge — three surfaces publishing
    // cross-module co-change, one spelling of what counts as evidence. Drop
    // the whole set rather than re-scoping `modules` to the linked subset:
    // `files` is documented as exactly the community's membership, and a
    // narrowed span above an unnarrowed file list is a subtler version of the
    // same lie.
    const memberIds = new Set(members);
    const linked = new Set<string>();
    for (const e of edges) {
      if (isSyntheticBridge(e) || edgeWeight(e) === 0) continue;
      if (!memberIds.has(e.a) || !memberIds.has(e.b)) continue;
      const pa = files[e.a];
      const pb = files[e.b];
      if (pa === undefined || pb === undefined) continue;
      const ma = moduleOf(pa);
      const mb = moduleOf(pb);
      if (ma === mb) continue;
      linked.add(ma);
      linked.add(mb);
    }
    if (modules.some((m) => !linked.has(m))) continue;

    // A set of exactly two files that `classifyPair` does not call a real
    // candidate IS that noise pair and nothing else — in practice a lockfile
    // moving with its manifest. Suppress it.
    //
    // Only the mechanical case can actually arrive here. `classifyPair`'s
    // range is `"mechanical" | "test-subject" | "candidate"` — it never
    // returns `"intra-module"` at all, which needs a `Spine` it does not take
    // (see its own doc; `drift` applies that grade separately) — and
    // `"test-subject"` cannot reach this line either: A8 strips test ids from
    // the edge set BEFORE `louvain()` runs (analyze.ts) and excludes them from
    // the partition on top of that, so no test file ever lands in a community.
    // `classifyPair` is still the right call rather
    // than an open-coded manifest test — it is this package's single spelling
    // of "mechanical co-change" — but do not read this as handling
    // test-subject pairs. It does not, because it cannot.
    //
    // Do NOT generalise to "contains a noisy pair": a ten-file set that
    // happens to include a lockfile is still a real working set, and dropping
    // it would delete the mission's own headline result. The rule is scoped
    // to the case where the noise pair IS the set.
    if (paths.length === 2) {
      const [a, b] = paths;
      if (a !== undefined && b !== undefined && classifyPair(a, b) !== "candidate") continue;
    }

    // `nameCluster` already returns file PATHS, not numeric ids (see its
    // return type and analyze.ts's own use of the result as an argument to
    // `spine.moduleOf`) — indexing `files[]` with it a second time would look
    // up a string key on an array and silently yield `undefined` for every
    // set, exactly the dangling-name defect A5c's "name is a path" rule
    // exists to prevent.
    const primary = nameCluster(members, edges, files, 1)[0];
    const name = primary ?? paths[0];
    if (name === undefined) continue;
    out.push({ name, modules, files: paths });
  }
  // Largest first: the biggest disagreement is the one worth reading. Ties on
  // name, through the same comparator every other ordering here uses.
  return out.sort((x, y) => y.files.length - x.files.length || compare(x.name, y.name));
}
