import type { Analysis } from "./analyze.js";
import { compare, modulePageRank } from "./rollup.js";

/** chars/4, the same fallback wikis' token_counter uses without tiktoken.
 *  Exact enough: the budget decides how many module and dependency lines to
 *  render, and that decision is not sensitive to a ±15% estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderMap(analysis: Analysis, budgetTokens: number): string {
  const header = [
    "# Module map",
    "",
    `- commits analysed: ${analysis.commitCount}`,
    // Not "files": `fileCount` is `PairTable.files.length`, i.e. only the files
    // that appear in an analysable commit touching two or more paths. On this
    // repo that is a third of the tracked tree. A bare "files: N" reads as a
    // repo total, which is the partial-presented-as-total failure the header
    // line below already guards for the Modules section.
    `- files in the co-change graph: ${analysis.fileCount}`,
    `- declared spine: ${analysis.spineSource}`,
    `- hubs quarantined: ${analysis.hubs.length}`,
    "- files never co-changed with another file: omitted below",
    "",
    "## Modules",
    "",
    // What a module row actually counts. `analyze` names each row for a
    // Louvain community's most central file (or a hub's own declared module,
    // or a Graphify-only endpoint — see analyze.ts), but the FILES listed
    // under it are that module's declared membership
    // (`filesByModule(table.files, spine.moduleOf)`), per spec A5c: "module
    // identity comes from the declared spine when present." A community can
    // sweep in files declared under a different module than the one whose
    // name it won; those files stay listed under their own declared row, not
    // under whichever heading absorbed their community. Without this line the
    // count reads as "this module contains N files" without saying which N.
    "_A row's files are the declared module's own membership; the row is named"
      + " for the community that won the naming vote, but that community's"
      + " other members are not counted here — see each of THEIR declared"
      + " rows instead._",
    "",
  ];

  // Spec A9: truncation must keep the most CENTRAL modules, not the biggest
  // ones — centrality is the signal the map exists to convey. Rank every
  // module by descending PageRank over the module graph before building
  // anything below, and read `ranked` (never `analysis.modules`) from here
  // on, so the module list, the truncation slice and the edge-endpoint
  // "shown" set all agree on one order. Ties (isolated modules with no
  // moduleEdges all score identically) break on `compare(name)` — the same
  // comparator every other ordering in this package uses — for determinism.
  const scores = modulePageRank(
    analysis.moduleEdges,
    analysis.modules.map((m) => m.name),
  );
  const ranked = [...analysis.modules].sort(
    (a, b) => (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0) || compare(a.name, b.name),
  );

  const lines: string[] = [];
  for (const m of ranked) {
    const layer = m.layer === null ? "" : ` [layer ${m.layer}]`;
    lines.push(`- **${m.name}**${layer} — ${m.members.length} co-changed files`);
  }

  // An arrow is a claim, and only one of the two edge producers can back it.
  // A Graphify spine states which module imports which, so `from → to` is the
  // fact. A co-change rollup states only that two modules move together;
  // `rollUp` orders its endpoints lexicographically to key an accumulator, so
  // rendering that as an arrow invents a direction — and gets it backwards
  // whenever the dependency runs against alphabetical order (`web` importing
  // `api` rolls up to `api → web`, which reads as "api depends on web"). map.md
  // is loaded into an agent's context as architecture truth, so it says only
  // what it knows: `↔`, under a heading that names the weaker relation.
  const directed = analysis.moduleEdgesDirected;
  const section = directed ? "## Dependencies" : "## Coupling (undirected co-change)";
  const link = directed ? "→" : "↔";
  const edgeUnit = directed ? "dependency edge" : "coupling edge";
  // The parenthesised number means two different things on the two branches —
  // a count of declared import edges from `readGraphify`, a sum of decayed nPMI
  // from `rollUp` — and they are not on the same scale (1.00 against 46.07 on
  // this repo). Same rule as the arrow above: the surface names its own unit
  // rather than leaving a reader to infer one from the tier.
  const weightUnit = directed
    ? "_Weight is the number of declared import edges between the two modules._"
    : "_Weight is summed decayed nPMI over co-changed file pairs, not a count._";

  // Only edges whose BOTH endpoints still have a heading. Truncation below cuts
  // the module list, and an edge naming a module that was cut is a dangling
  // reference in a committed artifact — the same defect `analyze`'s
  // module-identity backstop closes upstream (see analyze.ts), reopened here by
  // trimming the two lists independently. `analyze` guarantees every endpoint
  // has a heading BEFORE the budget runs; keeping that true after it is this
  // function's half of the invariant.
  const visibleEdges = (keptModules: number): string[] => {
    const shown = new Set(ranked.slice(0, keptModules).map((m) => m.name));
    return analysis.moduleEdges
      .filter((e) => shown.has(e.from) && shown.has(e.to))
      .map((e) => `- ${e.from} ${link} ${e.to} (${e.weight.toFixed(2)})`);
  };

  const note = (dropped: number, unit: string): string[] =>
    dropped > 0 ? ["", `_${dropped} ${unit}(s) truncated to fit the token budget._`] : [];

  const compose = (keptModules: number, keptEdges: number): string => {
    const shownEdges = visibleEdges(keptModules).slice(0, Math.max(0, keptEdges));
    return (
      [
        ...header,
        ...lines.slice(0, keptModules),
        ...note(lines.length - keptModules, "module"),
        "",
        section,
        "",
        weightUnit,
        "",
        ...shownEdges,
        // Counted against the FULL edge list, not against what survived the
        // endpoint filter: an edge hidden because its module was trimmed is
        // still an edge the reader is not being shown, and both causes are the
        // budget.
        ...note(analysis.moduleEdges.length - shownEdges.length, edgeUnit),
      ].join("\n") + "\n"
    );
  };

  /** Geometric shrink: ~12% of what is left, at least one line. */
  const shrink = (n: number): number => Math.max(0, n - Math.max(1, Math.ceil(n / 8)));

  // Trim from the tail of BOTH lists. `lines` (built from `ranked` above) is
  // ordered by descending module PageRank, and edges are ordered by weight
  // (see analyze.ts / rollUp), so the most CENTRAL modules and the strongest
  // couplings survive truncation — the ranking spec A9 requires.
  //
  // The dependency list has to be bounded too, not just the module list: it is
  // quadratic in the module count, so a repo with a few dozen modules can emit
  // hundreds of edge lines. Trimming only modules leaves that section whole and
  // blows the budget however far the module list is cut back — which was the
  // failure this loop is written to make impossible, since the budget is what
  // keeps map.md loadable as agent context.
  //
  // Whichever list is currently longer gives up the next slice, so neither
  // section is starved to pay for the other.
  let keptModules = lines.length;
  let keptEdges = analysis.moduleEdges.length;
  let out = compose(keptModules, keptEdges);
  while (estimateTokens(out) > budgetTokens) {
    // Measure against what is actually RENDERED, not against `keptEdges`:
    // trimming a module hides its edges too, so a stale `keptEdges` would keep
    // charging the edge section for lines that are no longer there and starve
    // the module list. It is also what makes the loop terminate — every branch
    // strictly decreases one of the two, and both bottom out at zero.
    const shownEdges = Math.min(keptEdges, visibleEdges(keptModules).length);
    if (keptModules + shownEdges === 0) break;
    if (keptModules >= shownEdges) keptModules = shrink(keptModules);
    else keptEdges = shrink(shownEdges);
    out = compose(keptModules, keptEdges);
  }
  return out;
}
