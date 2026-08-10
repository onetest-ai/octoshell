import type { Analysis } from "./analyze.js";
import { isTestPath } from "./noise.js";
import { compare, modulePageRank } from "./rollup.js";
import type { WorkingSet } from "./working-sets.js";

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

  // Spec A8 (amended 2026-08-10): test files stay in `members` — dropping
  // them would throw away "which tests cover this module", the same data
  // that makes `impact` useful to the completion gate — but a single mixed
  // total would silently blend them into "N co-changed files", which is the
  // file-count-as-total defect the comment above already guards against for
  // solo-commit files. So the count is split: `${source} source, ${test}
  // test co-changed files` whenever a module has at least one test member.
  // The far more common all-source case keeps the ORIGINAL unbroken
  // wording — `${source} co-changed files`, no "0 test" — because a mixed
  // count naming a part that is always zero is noise for the overwhelming
  // majority of rows, not honesty. An all-TEST module (zero source members)
  // is the deliberate exception: that is a genuinely unusual state worth
  // naming explicitly (`0 source, N test`), not the noise case above,
  // because a reader would otherwise have no way to tell "this module has no
  // source files at all" from "this render just didn't say".
  const countLabel = (members: string[]): string => {
    const testCount = members.filter((p) => isTestPath(p)).length;
    const sourceCount = members.length - testCount;
    return testCount === 0
      ? `${sourceCount} co-changed files`
      : `${sourceCount} source, ${testCount} test co-changed files`;
  };

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
    lines.push(`- **${m.name}**${layer} — ${countLabel(m.members)}`);
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

  // "Which modules still have a heading after the budget cut the list" — one
  // spelling, read by every section that names a module. Both dangling-
  // reference filters below are the SAME rule applied to two payloads; spelling
  // the slice twice is how they drift the day the module list stops being a
  // prefix of `ranked` (a pinned module, a minimum, a second sort), and a
  // renderer whose two filters disagree emits exactly the dangling reference
  // they exist to prevent.
  const shownModules = (keptModules: number): Set<string> =>
    new Set(ranked.slice(0, keptModules).map((m) => m.name));

  // Only edges whose BOTH endpoints still have a heading. Truncation below cuts
  // the module list, and an edge naming a module that was cut is a dangling
  // reference in a committed artifact — the same defect `analyze`'s
  // module-identity backstop closes upstream (see analyze.ts), reopened here by
  // trimming the two lists independently. `analyze` guarantees every endpoint
  // has a heading BEFORE the budget runs; keeping that true after it is this
  // function's half of the invariant.
  const visibleEdges = (keptModules: number): string[] => {
    const shown = shownModules(keptModules);
    return analysis.moduleEdges
      .filter((e) => shown.has(e.from) && shown.has(e.to))
      .map((e) => `- ${e.from} ${link} ${e.to} (${e.weight.toFixed(2)})`);
  };

  const note = (dropped: number, unit: string): string[] =>
    dropped > 0 ? ["", `_${dropped} ${unit}(s) truncated to fit the token budget._`] : [];

  // What a working set's file list actually IS, stated at the surface that
  // publishes it. `WorkingSet.files` is exactly one Louvain community's
  // membership, and `analyze` strips quarantined hubs and test files from the
  // edge set BEFORE clustering runs (A8 and the hub quarantine) — so a hub that
  // churns with every member, and every test that covers them, are absent by
  // construction. working-sets.ts's own doc comment names the only claim this
  // field supports — "these N files form one community", never "these are all
  // the files that move together" — and an unqualified "files that move
  // together" above a count is the second claim: the partial-presented-as-total
  // defect the Modules header and `- files in the co-change graph:` already
  // guard for their own narrower counts, at a third surface.
  const WORKING_SETS_NOTE =
    "_Each entry is one co-change community whose files span two or more declared modules."
    + " Observed from commit history; a working set is evidence of coupling, not a proposal"
    + " to change any boundary. Membership is the community's own: quarantined hubs and test"
    + " files are held out of clustering, so a file that moves with the set can be absent"
    + " from its list and its count._";

  // Criterion 6, and the third surface this invariant has had to be pinned at
  // (in-memory Analysis, then the Graphify branch, then rendered markdown).
  // Same rule as `visibleEdges`: a working set naming a module the budget cut
  // is a dangling reference in a committed artifact. Pinned at the boundary
  // the harm crosses — the rendered file — not at the layer it was found in.
  const visibleSets = (keptModules: number): WorkingSet[] => {
    const shown = shownModules(keptModules);
    return analysis.workingSets.filter((w) => w.modules.every((m) => shown.has(m)));
  };

  // Slice by SET, then flat-map to lines — never the reverse. `visibleEdges`
  // returns lines and is sliced by line because one edge is exactly one line;
  // a working set is a header plus N file lines, so slicing its lines would cut
  // a set mid-membership and render a header claiming "10 files" above four of
  // them. That is the partial-presented-as-total defect the Modules header
  // comment already guards, reintroduced at a new surface.
  const setLines = (sets: WorkingSet[]): string[] =>
    sets.flatMap((w) => [
      `- **${w.name}** — ${w.files.length} files across ${w.modules.join(", ")}`,
      ...w.files.map((f) => `  - ${f}`),
    ]);

  /** The sets this pair of counters actually renders — read by `compose` and by
   *  the shrink loop, so the loop weighs the section it is really emitting. */
  const shownSetsFor = (keptModules: number, keptSets: number): WorkingSet[] =>
    visibleSets(keptModules).slice(0, Math.max(0, keptSets));

  const compose = (keptModules: number, keptEdges: number, keptSets: number): string => {
    const shownEdges = visibleEdges(keptModules).slice(0, Math.max(0, keptEdges));
    const shownSets = shownSetsFor(keptModules, keptSets);
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
        // The heading itself is conditional (criterion 1: an empty result is
        // NO heading, not an empty one) but the truncation note is not — a
        // working set cut down to zero by the budget is still something the
        // reader is not being shown, exactly the edge-section precedent above.
        ...(shownSets.length > 0
          ? ["", "## Working sets", "", WORKING_SETS_NOTE, "", ...setLines(shownSets)]
          : []),
        ...note(analysis.workingSets.length - shownSets.length, "working set"),
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
  let keptSets = analysis.workingSets.length;
  let out = compose(keptModules, keptEdges, keptSets);
  while (estimateTokens(out) > budgetTokens) {
    // Measure against what is actually RENDERED, not against `keptEdges` /
    // `keptSets`: trimming a module hides its edges AND any working set
    // naming it too, so a stale counter would keep charging a section for
    // lines that are no longer there and starve the other two. It is also
    // what makes the loop terminate — every branch strictly decreases one of
    // the three, and all three bottom out at zero.
    const shownEdges = Math.min(keptEdges, visibleEdges(keptModules).length);
    const sets = shownSetsFor(keptModules, keptSets);
    const shownSets = sets.length;
    // Compare LINES, never items. A module row and an edge are one line each,
    // so the original two-counter loop could compare the counters directly; a
    // working set is a header plus N file lines, so its COUNT is not its cost.
    // Comparing counts made one 200-file set (201 lines) lose every tiebreak
    // to a 16-line module list, which then shrank to a single row — under a
    // budget the full module list fit inside — and the set was dropped by the
    // dangling filter anyway once the modules it names lost their headings.
    // The section that occupies the most lines pays; that is what "no section
    // is starved to pay for the others" has to mean when one of them renders
    // more than one line per item.
    const setLineCount = setLines(sets).length;
    if (keptModules + shownEdges + shownSets === 0) break;
    // Whichever of the three currently occupies the most LINES gives up the
    // next slice, so no section is starved to pay for the other two. Each
    // branch still strictly decreases its own counter: the branch below is
    // reachable only when `setLineCount` exceeds one of the other two, and a
    // non-zero line count implies at least one shown set, so `shrink` always
    // has something to take.
    if (keptModules >= shownEdges && keptModules >= setLineCount) keptModules = shrink(keptModules);
    else if (shownEdges >= keptModules && shownEdges >= setLineCount) keptEdges = shrink(shownEdges);
    else keptSets = shrink(shownSets);
    out = compose(keptModules, keptEdges, keptSets);
  }
  return out;
}
