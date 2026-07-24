#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpEntity, siblingSlugs, slugify, uniqueSlug } from "./entity-io.mjs";

// Create a campaign: `<root>/campaigns/<slug>/campaign.yaml`. Disk is the source of truth — a campaign
// IS its folder, identified by its folder path (`folder:<relPath>`). The campaign carries only its own
// fields; its missions are folder-derived (discovered by scanning `missions/`), never enumerated here.
// Optional `--description` / `--target` fill the fields; `--root` overrides `.octobots`.
const rawArgs = process.argv.slice(2);
let description = "";
let target = "";
let root = ".octobots";
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--description") description = (rawArgs[++i] ?? "").trim();
  else if (rawArgs[i] === "--target") target = (rawArgs[++i] ?? "").trim();
  else if (rawArgs[i] === "--root") root = (rawArgs[++i] ?? "").trim() || ".octobots";
  else positional.push(rawArgs[i]);
}

const name = (positional[0] ?? "").trim();
if (!name) {
  console.error('usage: add-campaign.js "<name>" [--description <text>] [--target <text>] [--root <dir>]');
  process.exit(2);
}

const campaignsDir = join(root, "campaigns");
const slug = uniqueSlug(slugify(name), siblingSlugs(campaignsDir));
const campaignDir = join(campaignsDir, slug);
mkdirSync(campaignDir, { recursive: true });

writeFileSync(
  join(campaignDir, "campaign.yaml"),
  dumpEntity("campaign", {
    name,
    description,
    target,
    status: "draft",
    acceptanceCriteria: [],
    documents: [],
  }),
  "utf8",
);
console.log(`added campaign: ${name} (campaigns/${slug})`);
