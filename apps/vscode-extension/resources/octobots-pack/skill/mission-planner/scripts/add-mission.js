#!/usr/bin/env node
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpEntity, siblingSlugs, slugify, uniqueSlug } from "./entity-io.mjs";

// Create a mission under a campaign: `<campaignDir>/missions/<slug>/mission.yaml`. Disk is the source
// of truth — a mission IS its folder (`folder:<relPath>`). It carries only its own fields; the campaign
// is NOT touched — missions are folder-derived, discovered by scanning `missions/`. The mission starts
// with no acceptance criteria — add them with set-criterion.js (validate.js requires at least one).
const rawArgs = process.argv.slice(2);
let description = "";
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--description") description = (rawArgs[++i] ?? "").trim();
  else positional.push(rawArgs[i]);
}

const arg = positional[0];
const title = (positional[1] ?? "").trim();
if (!arg || !title) {
  console.error('usage: add-mission.js <campaign-dir|campaign.yaml> "<title>" [--description <text>]');
  process.exit(2);
}
// Resolve the campaign folder from a dir or a campaign.yaml/.md file path. A campaign IS its folder,
// so accept either shape whether the folder still has campaign.yaml or a legacy campaign.md.
const campaignDir = existsSync(arg) && statSync(arg).isDirectory() ? arg : dirname(arg);
if (!existsSync(join(campaignDir, "campaign.yaml")) && !existsSync(join(campaignDir, "campaign.md"))) {
  console.error(`add-mission: not a campaign folder (no campaign.yaml/.md): ${campaignDir}`);
  process.exit(2);
}

const missionsDir = join(campaignDir, "missions");
const slug = uniqueSlug(slugify(title), siblingSlugs(missionsDir));
const missionDir = join(missionsDir, slug);
mkdirSync(missionDir, { recursive: true });

writeFileSync(
  join(missionDir, "mission.yaml"),
  dumpEntity("mission", { name: title, description, acceptanceCriteria: [], documents: [] }),
  "utf8",
);
console.log(`added mission: ${title} (missions/${slug})`);
