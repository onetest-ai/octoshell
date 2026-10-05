#!/usr/bin/env node
// QA harness (campaign "Test conventions" rule 3, owned by M3/T3.3). NOT part of the shipped extension.
//
// Usage: node apps/vscode-extension/scripts/qa/dump-ids.mjs <octobots-dir> [--board-dist <path to a built @octoshell/board dist/index.js>]
//
// Loads <octobots-dir> (the folder holding campaigns/) with a BoardModel and prints one line per
// campaign, mission, task and bug: `<kind>\t<id>`, sorted. Writes nothing.
//
// --board-dist lets the SAME board be read by a different build of the library, so a before/after
// diff proves ids did not move: build main's packages/board, point --board-dist at its
// dist/index.js, and diff its output with this branch's. The default is this repo's
// packages/board/dist/index.js (run `pnpm build` first).
//
// Plain node, and only the BoardModel API that exists on main and on the branch that dropped
// workflows: rebuild(), listCampaigns(), listMissions(id), listTasks(id), listBugs({campaignId}|{missionId}).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = "usage: dump-ids.mjs <octobots-dir> [--board-dist <path to a built @octoshell/board dist/index.js>]";
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
if (positional.length !== 1) { console.error(usage); process.exit(2); }

const dir = resolve(positional[0]);
if (!existsSync(dir)) { console.error(`dump-ids: not found: ${dir}`); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const dist = distArg ? resolve(distArg) : join(here, "..", "..", "..", "..", "packages", "board", "dist", "index.js");
if (!existsSync(dist)) { console.error(`dump-ids: board dist not found: ${dist} (run pnpm build, or pass --board-dist)`); process.exit(2); }

const { BoardModel } = await import(pathToFileURL(dist).href);
const board = new BoardModel(dir);
board.rebuild();

const lines = [];
for (const c of board.listCampaigns()) {
  lines.push(`campaign\t${c.id}`);
  for (const b of board.listBugs({ campaignId: c.id })) lines.push(`bug\t${b.id}`);
  for (const m of board.listMissions(c.id)) {
    lines.push(`mission\t${m.id}`);
    for (const t of board.listTasks(m.id)) lines.push(`task\t${t.id}`);
    for (const b of board.listBugs({ missionId: m.id })) lines.push(`bug\t${b.id}`);
  }
}
lines.sort();
if (lines.length) process.stdout.write(lines.join("\n") + "\n");
