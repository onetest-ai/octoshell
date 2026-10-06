#!/usr/bin/env node
// QA harness (campaign "Test conventions" rule 3, owned by M1/T1.2). NOT part of the shipped extension.
//
// Usage: node apps/vscode-extension/scripts/qa/tokenomics-report.mjs <workspace>
//
// Makes the same ClaudeTranscriptSource + rollup calls the `tokenomics:report` RPC makes
// (src/host/rpc-dispatcher.ts), against <workspace>, and prints what the extension's Tokenomics view
// would read from disk. Writes nothing. Roots follow the extension's rules: OCTOBOTS_TOKENOMICS_PROJECTS_DIR
// > $CLAUDE_CONFIG_DIR/projects > ~/.claude/projects (HOME is honoured, so tests inject a temp one), plus the
// legacy <main checkout>/.claude/projects.
//
// Prints JSON: {workspace, slug, roots[], segments, sessions[], slugs[]}
//   segments  count of segments the source returned
//   sessions  sorted unique session ids
//   slugs     the project slug directories (one per root) that exist, i.e. that can contribute
//
// Imports resolve through the workspace dependency to packages/*/dist: run `pnpm build` first.

import { resolve } from "node:path";
import { BoardModel } from "@octoshell/board";
import { ClaudeTranscriptSource, rollup } from "@octoshell/tokenomics";

const arg = process.argv[2];
if (!arg || arg.startsWith("-")) {
  console.error("usage: tokenomics-report.mjs <workspace>");
  process.exit(2);
}
const workspace = resolve(arg);

const source = new ClaudeTranscriptSource(workspace);
const board = new BoardModel(resolve(workspace, ".octobots"));
board.rebuild();
// The RPC's rollup call. The printed contract is the source's view; rollup must not throw on this workspace.
rollup({ repoRoot: workspace, artifactsRoot: resolve(workspace, ".octobots"), board, source });

const segments = source.collect();
console.log(JSON.stringify({
  workspace,
  slug: source.slug,
  roots: source.roots,
  segments: segments.length,
  sessions: [...new Set(segments.map((s) => s.sessionId))].sort(),
  slugs: source.slugDirs(),
}, null, 2));
