import type { Analysis } from "./analyze.js";

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
    `- files: ${analysis.fileCount}`,
    `- declared spine: ${analysis.spineSource}`,
    `- hubs quarantined: ${analysis.hubs.length}`,
    "",
    "## Modules",
    "",
  ];

  const lines: string[] = [];
  for (const m of analysis.modules) {
    const layer = m.layer === null ? "" : ` [layer ${m.layer}]`;
    lines.push(`- **${m.name}**${layer} — ${m.members.length} files`);
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

  const edges: string[] = [];
  for (const e of analysis.moduleEdges) {
    edges.push(`- ${e.from} ${link} ${e.to} (${e.weight.toFixed(2)})`);
  }

  const note = (dropped: number, unit: string): string[] =>
    dropped > 0 ? ["", `_${dropped} ${unit}(s) truncated to fit the token budget._`] : [];

  const compose = (keptModules: number, keptEdges: number): string =>
    [
      ...header,
      ...lines.slice(0, keptModules),
      ...note(lines.length - keptModules, "module"),
      "",
      section,
      "",
      ...edges.slice(0, keptEdges),
      ...note(edges.length - keptEdges, edgeUnit),
    ].join("\n") + "\n";

  /** Geometric shrink: ~12% of what is left, at least one line. */
  const shrink = (n: number): number => Math.max(0, n - Math.max(1, Math.ceil(n / 8)));

  // Trim from the tail of BOTH lists. Modules are ordered by size and edges by
  // weight (see analyze.ts / rollUp), so the largest and strongest survive
  // truncation; this is not a centrality ranking.
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
  let keptEdges = edges.length;
  let out = compose(keptModules, keptEdges);
  while (estimateTokens(out) > budgetTokens && keptModules + keptEdges > 0) {
    if (keptModules >= keptEdges) keptModules = shrink(keptModules);
    else keptEdges = shrink(keptEdges);
    out = compose(keptModules, keptEdges);
  }
  return out;
}
