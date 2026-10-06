#!/usr/bin/env node
// QA harness (campaign "Test conventions" rule 3, owned by M6/T6.1). NOT part of the shipped extension.
//
// Usage: node apps/vscode-extension/scripts/qa/dump-tests.mjs <octobots-dir> <campaign-slug> [--board-dist <path to a built @octoshell/board dist/index.js>]
//
// Loads <octobots-dir> (the folder holding campaigns/) with a BoardModel and prints, as one JSON array, what
// `listTestCases(<campaign>)` returns for the campaign whose folder is campaigns/<campaign-slug>:
// `{id, title, mission, covers, kind, status, lastRun?, path}` per tests/m<n>/TC-*.md file, `path` relative to
// <octobots-dir>. Writes nothing. Exit 2 on bad usage, a missing board, dist or campaign.
//
// --board-dist reads the board through a different build of the library (default: this repo's
// packages/board/dist/index.js, so run `pnpm build` first).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = "usage: dump-tests.mjs <octobots-dir> <campaign-slug> [--board-dist <path to a built @octoshell/board dist/index.js>]";
const args = process.argv.slice(2);
let distArg = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--board-dist") {
    distArg = args[++i] ?? null;
    if (!distArg) { console.error(usage); process.exit(2); }
  } else if (args[i].startsWith("--board-dist=")) {
    distArg = args[i].slice("--board-dist=".length);
  } else if (args[i].startsWith("-")) {
    console.error(usage); process.exit(2);
  } else positional.push(args[i]);
}
if (positional.length !== 2) { console.error(usage); process.exit(2); }

const dir = resolve(positional[0]);
const slug = positional[1];
if (!existsSync(dir)) { console.error(`dump-tests: not found: ${dir}`); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const dist = distArg ? resolve(distArg) : join(here, "..", "..", "..", "..", "packages", "board", "dist", "index.js");
if (!existsSync(dist)) { console.error(`dump-tests: board dist not found: ${dist} (run pnpm build, or pass --board-dist)`); process.exit(2); }

const { BoardModel } = await import(pathToFileURL(dist).href);
const board = new BoardModel(dir);
board.rebuild();
const campaign = board.listCampaigns().find((c) => c.folderPath === `campaigns/${slug}`);
if (!campaign) { console.error(`dump-tests: no campaign "${slug}" under ${dir}`); process.exit(2); }

process.stdout.write(JSON.stringify(board.listTestCases(campaign.id), null, 2) + "\n");
