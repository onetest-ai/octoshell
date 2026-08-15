#!/usr/bin/env node
// Resolve everything a shared pipeline needs for one mission, as JSON on stdout.
//
//   node .claude/skills/mission-planner/scripts/mission-input.js M2 [--campaign <slug>] [--pretty]
//
// Why this is a separate process: a workflow script has no filesystem access — require, process,
// fs and fetch are all undefined and import() is blocked at parse — so a pipeline cannot discover
// its own mission. Discovery happens here, and the result is handed to the pipeline as `args`.
// This is what lets one shared pipeline replace a generated copy per mission.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEntity, resolveEntityFile } from "./entity-io.mjs";

const argv = process.argv.slice(2);
const pretty = argv.includes("--pretty");
const campaignFlagIdx = argv.indexOf("--campaign");
// Mission ids are numbered sequentially WITHIN their campaign (mission-planner § board shape), not
// board-wide — the same id can legitimately exist under two campaigns. `--campaign <slug>` picks
// one when that happens; without it, an ambiguous id is refused rather than guessed at.
const campaignSlug = campaignFlagIdx >= 0 ? argv[campaignFlagIdx + 1] : undefined;
const id = (argv[0] ?? "").toUpperCase();
if (!/^M\d+$/.test(id)) {
  console.error("usage: mission-input.js M<n> [--campaign <slug>] [--pretty]");
  process.exit(2);
}

const ROOT = join(".octobots", "campaigns");
const dirs = (p) =>
  existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/** Every campaign (optionally narrowed to `--campaign <slug>`) whose missions/ has this id's slug prefix. */
const matches = [];
for (const campaign of dirs(ROOT)) {
  if (campaignSlug && campaign !== campaignSlug) continue;
  const missions = join(ROOT, campaign, "missions");
  const hit = dirs(missions).find((slug) => slug.startsWith(`${id.toLowerCase()}-`));
  if (hit) matches.push({ campaign, missionDir: join(missions, hit), campaignDir: join(ROOT, campaign) });
}

if (matches.length === 0) {
  const scope = campaignSlug ? ` under campaign "${campaignSlug}"` : "";
  console.error(`mission-input: ${id} is not on the board${scope}`);
  process.exit(1);
}
if (matches.length > 1) {
  const candidates = matches.map((m) => m.campaign).join(", ");
  console.error(`mission-input: ${id} is ambiguous — it exists under ${matches.length} campaigns: ${candidates}. Pass --campaign <slug> to disambiguate.`);
  process.exit(1);
}
const { missionDir, campaignDir } = matches[0];

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

/**
 * `T1.2 - Name` → id and label; tasks sort by their FULL numeric id — major, then minor — via
 * numeric-aware string collation, so `T3.10` sorts after `T3.9` (not string order) and `T10.1`
 * sorts after `T2.1` (a naive "read the part after the dot" compare gets both of these wrong).
 */
const tasks = dirs(join(missionDir, "tasks"))
  .map((slug) => {
    const dir = join(missionDir, "tasks", slug);
    const task = read(dir, "task");
    const [taskId, ...rest] = String(task.name ?? "").split(" - ");
    return { id: (taskId ?? "").trim(), label: rest.join(" - ").trim(), dir, criteria: criteriaOf(task) };
  })
  .filter((t) => /^T\d+\.\d+$/i.test(t.id))
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

// The QA/verification task is the mission's LAST matching one, by convention (mission-planner §
// task shape puts QA at the end). If more than one task label matches, the later task wins — that
// tie-break is deliberate, not an oversight.
const qaTask = [...tasks].reverse().find((t) => /\bqa\b|verification/i.test(t.label)) ?? null;

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
