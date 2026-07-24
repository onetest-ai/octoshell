#!/usr/bin/env node
// Delete a bug: trash its `bugs/<slug>/` folder. Bugs are folder-derived (the parent never enumerates
// them), so removing the folder IS the delete — no parent board line to edit. The trashed folder moves
// under `.octobots/.trash/`; the app's reconcile finalizes the removal.
import { existsSync, statSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { entityName } from "./entity-io.mjs";

const rawArgs = process.argv.slice(2);
const arg = rawArgs[0];
const title = (rawArgs[1] ?? "").trim();
if (!arg || !title) {
  console.error('usage: delete-bug.js <campaign-dir|mission-dir|entity.yaml> "<bug title>"');
  process.exit(2);
}
// Resolve the parent folder (mission or campaign) from a dir or an entity file path.
const parentDir = existsSync(arg) && statSync(arg).isDirectory() ? arg : dirname(arg);
if (!existsSync(parentDir)) { console.error(`delete-bug: parent folder not found: ${parentDir}`); process.exit(2); }
const titleKey = title.toLowerCase();

let folderTrashed = false;
const bugsDir = join(parentDir, "bugs");
if (existsSync(bugsDir)) {
  for (const slug of readdirSync(bugsDir)) {
    const bugFolder = join(bugsDir, slug);
    if (!existsSync(bugFolder) || !statSync(bugFolder).isDirectory()) continue;
    if (entityName(bugFolder, "bug").toLowerCase() === titleKey) {
      trashFolder(bugFolder);
      folderTrashed = true;
      break;
    }
  }
}

if (!folderTrashed) {
  console.error(`delete-bug: no bug titled "${title}" found (no bug.yaml/.md folder)`);
  process.exit(1);
}
console.log(`deleted bug: ${title} [folder→.trash]`);

/** Soft-delete a folder by moving it under `.octobots/.trash/` (mirrors the app); fall back to rm. */
function trashFolder(folder) {
  let root = folder;
  while (basename(root) !== ".octobots" && dirname(root) !== root) root = dirname(root);
  try {
    if (basename(root) === ".octobots") {
      const trash = join(root, ".trash");
      mkdirSync(trash, { recursive: true });
      let dest = join(trash, basename(folder));
      for (let n = 2; existsSync(dest); n++) dest = join(trash, `${basename(folder)}-${n}`);
      renameSync(folder, dest);
      return;
    }
  } catch { /* fall through */ }
  rmSync(folder, { recursive: true, force: true });
}
