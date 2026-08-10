import { classifyPair } from "./noise.js";
import { compare, nameCluster } from "./rollup.js";
import type { Edge } from "./weights.js";

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
 * graph the partition came from.
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
