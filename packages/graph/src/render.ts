import type { Analysis } from "./analyze.js";

/** chars/4, the same fallback wikis' token_counter uses without tiktoken.
 *  Exact enough: the budget decides how many modules to render, and that
 *  decision is not sensitive to a ±15% estimate. */
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

  const edgeLines = ["", "## Dependencies", ""];
  for (const e of analysis.moduleEdges) {
    edgeLines.push(`- ${e.from} → ${e.to} (${e.weight.toFixed(2)})`);
  }

  // Trim from the tail. Modules are ordered by size (see analyze.ts), so the
  // largest survive truncation; this is not a centrality ranking.
  let kept = lines.length;
  let out = "";
  for (;;) {
    const body = lines.slice(0, kept);
    const truncated = kept < lines.length
      ? ["", `_${lines.length - kept} module(s) truncated to fit the token budget._`]
      : [];
    out = [...header, ...body, ...edgeLines, ...truncated].join("\n") + "\n";
    if (estimateTokens(out) <= budgetTokens || kept === 0) break;
    kept = Math.max(0, kept - Math.max(1, Math.ceil(kept / 8)));
  }
  return out;
}
