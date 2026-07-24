#!/usr/bin/env node
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpEntity, siblingSlugs, slugify, uniqueSlug } from "./entity-io.mjs";

// Parse argv: extract optional --severity <level> flag (anywhere), leaving positional args.
const rawArgs = process.argv.slice(2);
let severity = null;
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--severity") severity = (rawArgs[++i] ?? "").trim().toLowerCase() || null;
  else positional.push(rawArgs[i]);
}

const arg = positional[0];
const title = (positional[1] ?? "").trim();
if (!arg || !title) {
  console.error('usage: add-bug.js <campaign-dir|mission-dir|entity.yaml> "<title>" [--severity blocker|critical|major|minor|trivial]');
  process.exit(2);
}
const SEVERITIES = ["blocker", "critical", "major", "minor", "trivial"];
if (severity && !SEVERITIES.includes(severity)) {
  console.error(`add-bug: invalid severity "${severity}" (expected one of: ${SEVERITIES.join(", ")})`);
  process.exit(2);
}
// Resolve the parent folder (a mission or campaign) from a dir or a mission.yaml/campaign.yaml/.md file.
const parentDir = existsSync(arg) && statSync(arg).isDirectory() ? arg : dirname(arg);
const isParent = ["mission.yaml", "mission.md", "campaign.yaml", "campaign.md"].some((n) => existsSync(join(parentDir, n)));
if (!isParent) {
  console.error(`add-bug: not a campaign/mission folder: ${parentDir}`);
  process.exit(2);
}
const sev = severity || "major";

// Disk is the source of truth: a bug IS a `bugs/<slug>/bug.yaml` folder (`folder:<relPath>`). Create
// ONLY the child folder + child yaml — the parent is NOT touched. The bug's severity/status live in its
// own bug.yaml; the parent derives its bug list by scanning `bugs/`. There is no parent projection.
const bugsDir = join(parentDir, "bugs");
const slug = uniqueSlug(slugify(title), siblingSlugs(bugsDir));
const bugDir = join(bugsDir, slug);
mkdirSync(bugDir, { recursive: true });

writeFileSync(
  join(bugDir, "bug.yaml"),
  dumpEntity("bug", { name: title, description: "", severity: sev, status: "draft" }),
  "utf8",
);
console.log(`added bug: ${title} (bugs/${slug})`);
