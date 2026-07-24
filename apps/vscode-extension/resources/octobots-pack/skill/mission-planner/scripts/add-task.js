#!/usr/bin/env node
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpEntity, siblingSlugs, slugify, uniqueSlug } from "./entity-io.mjs";

// Parse argv: extract optional --role <name> / --description <text> flags (anywhere), leaving positional args.
const rawArgs = process.argv.slice(2);
let role = null;
let description = "";
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--role") role = (rawArgs[++i] ?? "").trim() || null;
  else if (rawArgs[i] === "--description") description = (rawArgs[++i] ?? "").trim();
  else positional.push(rawArgs[i]);
}

const arg = positional[0];
const title = (positional[1] ?? "").trim();
if (!arg || !title) {
  console.error('usage: add-task.js <mission-dir|mission.yaml> "<title>" [--role <name>] [--description <text>]');
  process.exit(2);
}
// Resolve the mission folder from a dir or a mission.yaml/.md file path.
const missionDir = existsSync(arg) && statSync(arg).isDirectory() ? arg : dirname(arg);
if (!existsSync(join(missionDir, "mission.yaml")) && !existsSync(join(missionDir, "mission.md"))) {
  console.error(`add-task: not a mission folder (no mission.yaml/.md): ${missionDir}`);
  process.exit(2);
}

// Disk is the source of truth: a task IS a `tasks/<slug>/task.yaml` folder (`folder:<relPath>`). Create
// ONLY the child folder + child yaml — the mission is NOT touched. The task's role/status live in its
// own task.yaml, and the mission derives its task list by scanning `tasks/`; there is no parent projection.
const tasksDir = join(missionDir, "tasks");
const slug = uniqueSlug(slugify(title), siblingSlugs(tasksDir));
const taskDir = join(tasksDir, slug);
mkdirSync(taskDir, { recursive: true });

writeFileSync(
  join(taskDir, "task.yaml"),
  dumpEntity("task", { name: title, description, acceptanceCriteria: [], role: role ?? undefined, status: "draft" }),
  "utf8",
);
console.log(`added task: ${title} (tasks/${slug})`);
