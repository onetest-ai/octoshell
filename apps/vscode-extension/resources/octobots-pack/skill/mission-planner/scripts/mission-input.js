#!/usr/bin/env node
// Resolve everything a shared pipeline needs for one mission, as JSON on stdout.
//
//   node .claude/skills/mission-planner/scripts/mission-input.js M2 [--pretty]
//
// Why this is a separate process: a workflow script has no filesystem access — require, process,
// fs and fetch are all undefined and import() is blocked at parse — so a pipeline cannot discover
// its own mission. Discovery happens here, and the result is handed to the pipeline as `args`.
// This is what lets one shared pipeline replace a generated copy per mission.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEntity, resolveEntityFile } from "./entity-io.mjs";

const id = (process.argv[2] ?? "").toUpperCase();
const pretty = process.argv.includes("--pretty");
if (!/^M\d+$/.test(id)) {
  console.error("usage: mission-input.js M<n> [--pretty]");
  process.exit(2);
}

const ROOT = join(".octobots", "campaigns");
const dirs = (p) =>
  existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/** The mission folder whose name starts with this id's slug prefix, e.g. `m2-`. */
let missionDir = null;
let campaignDir = null;
for (const campaign of dirs(ROOT)) {
  const missions = join(ROOT, campaign, "missions");
  const hit = dirs(missions).find((slug) => slug.startsWith(`${id.toLowerCase()}-`));
  if (hit) {
    missionDir = join(missions, hit);
    campaignDir = join(ROOT, campaign);
    break;
  }
}
if (!missionDir || !campaignDir) {
  console.error(`mission-input: ${id} is not on the board`);
  process.exit(1);
}

const criteriaOf = (entity) => (entity.acceptanceCriteria ?? []).map((c) => c.text).filter(Boolean);

/** Read a `<kind>.yaml` (or legacy `.md`) from `dir`, or fail with a clear message. */
function read(dir, kind) {
  const resolved = resolveEntityFile(dir, [kind]);
  if (!resolved) {
    console.error(`mission-input: no ${kind} file in ${dir}`);
    process.exit(1);
  }
  return readEntity(resolved.file, resolved.format);
}

const mission = read(missionDir, "mission");

/** `T1.2 - Name` → id and label; tasks sort by their numeric id, not their folder name. */
const taskNumber = (taskId) => Number(String(taskId).replace(/^T/i, "").split(".")[1] ?? 0);
const tasks = dirs(join(missionDir, "tasks"))
  .map((slug) => {
    const dir = join(missionDir, "tasks", slug);
    const task = read(dir, "task");
    const [taskId, ...rest] = String(task.name ?? "").split(" - ");
    return { id: (taskId ?? "").trim(), label: rest.join(" - ").trim(), dir, criteria: criteriaOf(task) };
  })
  .filter((t) => /^T\d+\.\d+$/i.test(t.id))
  .sort((a, b) => taskNumber(a.id) - taskNumber(b.id));

// The QA verification task is the mission's last one by convention (mission-planner § task shape).
const qaTask = tasks.find((t) => /\bqa\b|verification/i.test(t.label)) ?? null;

const payload = {
  mission: id,
  missionName: mission.name ?? id,
  missionDir,
  campaignDir,
  criteria: criteriaOf(mission),
  tasks,
  qaTask,
};
console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
