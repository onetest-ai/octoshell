#!/usr/bin/env node
// Delete a task: trash its `tasks/<slug>/` folder. Tasks are folder-derived (the mission never
// enumerates them), so removing the folder IS the delete — no parent board line to edit. The trashed
// folder moves under `.octobots/.trash/`; the app's reconcile finalizes the removal.
import { existsSync, statSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { entityName } from "./entity-io.mjs";

const rawArgs = process.argv.slice(2);
const arg = rawArgs[0];
const name = (rawArgs[1] ?? "").trim();
if (!arg || !name) {
  console.error('usage: delete-task.js <mission-dir|mission.yaml> "<task name>"');
  process.exit(2);
}
// Resolve the mission folder from a dir or a mission.yaml/.md file path.
const missionDir = existsSync(arg) && statSync(arg).isDirectory() ? arg : dirname(arg);
if (!existsSync(missionDir)) { console.error(`delete-task: mission folder not found: ${missionDir}`); process.exit(2); }
const nameKey = name.toLowerCase();

let folderTrashed = false;
const tasksDir = join(missionDir, "tasks");
if (existsSync(tasksDir)) {
  for (const slug of readdirSync(tasksDir)) {
    const taskFolder = join(tasksDir, slug);
    if (!existsSync(taskFolder) || !statSync(taskFolder).isDirectory()) continue;
    if (entityName(taskFolder, "task").toLowerCase() === nameKey) {
      trashFolder(taskFolder);
      folderTrashed = true;
      break;
    }
  }
}

if (!folderTrashed) {
  console.error(`delete-task: no task named "${name}" found (no task.yaml/.md folder)`);
  process.exit(1);
}
console.log(`deleted task: ${name} [folder→.trash]`);

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
