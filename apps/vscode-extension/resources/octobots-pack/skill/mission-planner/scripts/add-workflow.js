#!/usr/bin/env node
// Scaffold a workflow under a campaign or a mission.
//
//   add-workflow.js --campaign <slug> [--mission <slug>] --name <name> [--description "<text>"]
//
// A campaign may hold several workflows (it orchestrates its missions); a mission has at most one
// (it orchestrates its tasks). Writes `workflows/<slug>/workflow.js` — name/description/phases live
// in its `meta`; run history is appended to a sibling `runs.jsonl` by add-run.js.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeMeta, slugify } from "./workflow-meta.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      args[tok.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

const { campaign, mission, name, description } = parseArgs(process.argv.slice(2));

if (!campaign || !name) {
  console.error('usage: add-workflow.js --campaign <slug> [--mission <slug>] --name <name> [--description "<text>"]');
  process.exit(2);
}

const campaignDir = join(process.cwd(), ".octobots", "campaigns", campaign);
if (!existsSync(join(campaignDir, "campaign.md"))) {
  console.error(`add-workflow: campaign not found: .octobots/campaigns/${campaign}`);
  process.exit(2);
}

let parentDir = campaignDir;
if (mission) {
  parentDir = join(campaignDir, "missions", mission);
  if (!existsSync(join(parentDir, "mission.md"))) {
    console.error(`add-workflow: mission not found: .octobots/campaigns/${campaign}/missions/${mission}`);
    process.exit(2);
  }
}

const workflowsDir = join(parentDir, "workflows");
const existing = existsSync(workflowsDir)
  ? readdirSync(workflowsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

if (mission && existing.length > 0) {
  console.error(
    `add-workflow: mission already has a workflow ("${existing[0]}"); a mission may have at most one`,
  );
  process.exit(2);
}

// De-duplicate the slug against siblings, matching the app's uniqueSlug.
const base = slugify(name);
let slug = base;
for (let n = 2; existing.includes(slug); n++) slug = `${base}-${n}`;

const outDir = join(workflowsDir, slug);
mkdirSync(outDir, { recursive: true });

const desc = (description ?? "").trim();

// A workflow is just its script (name/description/phases live in `meta`); run history is appended to
// a sibling runs.jsonl by add-run.js. No workflow.md.
const meta = {
  name: slug,
  description: desc,
  phases: [{ title: "Run", steps: [{ id: "s1", agent: "claude", label: name }] }],
};

writeFileSync(
  join(outDir, "workflow.js"),
  [
    `export const meta = ${serializeMeta(meta)}`,
    "",
    "// Body: use phase() / agent() / parallel() / pipeline().",
    "// Keep `meta.phases` above in step with the phases this body enters —",
    "// the Octobots board draws its diagram from meta, not from this code.",
    "phase('Run')",
    "",
  ].join("\n"),
  "utf8",
);

const rel = mission
  ? `.octobots/campaigns/${campaign}/missions/${mission}/workflows/${slug}`
  : `.octobots/campaigns/${campaign}/workflows/${slug}`;
console.log(`created ${rel}`);
