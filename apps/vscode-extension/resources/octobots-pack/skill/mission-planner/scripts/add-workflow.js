#!/usr/bin/env node
// Scaffold a workflow under a campaign or a mission.
//
//   add-workflow.js --campaign <slug> [--mission <slug>] --name <name> [--description "<text>"]
//
// Either parent may hold several: a campaign's workflows orchestrate its missions, a mission's
// orchestrate its tasks — and a mission normally has one per execution loop, `implementation`,
// `testing` and `fixing` (see the workflow-designer skill). Writes
// `workflows/<slug>/workflow.js` — name/description/phases live in its `meta`; run history is
// appended to a sibling `runs.jsonl` by add-run.js.

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

// A campaign/mission IS its folder — discover it whether it holds a `<kind>.yaml` (current) or a
// legacy `<kind>.md` (mid-migration). Workflows themselves are unchanged by the YAML migration.
const hasEntity = (dir, kind) => existsSync(join(dir, `${kind}.yaml`)) || existsSync(join(dir, `${kind}.md`));

const campaignDir = join(process.cwd(), ".octobots", "campaigns", campaign);
if (!hasEntity(campaignDir, "campaign")) {
  console.error(`add-workflow: campaign not found: .octobots/campaigns/${campaign}`);
  process.exit(2);
}

let parentDir = campaignDir;
if (mission) {
  parentDir = join(campaignDir, "missions", mission);
  if (!hasEntity(parentDir, "mission")) {
    console.error(`add-workflow: mission not found: .octobots/campaigns/${campaign}/missions/${mission}`);
    process.exit(2);
  }
}

const workflowsDir = join(parentDir, "workflows");
const existing = existsSync(workflowsDir)
  ? readdirSync(workflowsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

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
  // No steps: the body below only calls phase('Run') — validate now checks that meta agrees
  // with the body it was generated from, so a placeholder step here (with nothing in the body
  // to back it) would fail that check the moment the file is created.
  phases: [{ title: "Run", steps: [] }],
};

writeFileSync(
  join(outDir, "workflow.js"),
  [
    `export const meta = ${serializeMeta(meta)}`,
    "",
    "// Body: use phase() / agent() / parallel() / pipeline() / workflow().",
    "// The board's diagram is GENERATED from this code — after editing, run:",
    "//   node .claude/skills/mission-planner/scripts/sync-meta.js <this folder>",
    // Quoted the same way packages/board's `scaffoldScript` quotes it, so the two scaffolds are
    // byte-identical — a workflow created in the app and one created here are the same file.
    `phase(${JSON.stringify(meta.phases[0].title)})`,
    "",
  ].join("\n"),
  "utf8",
);

const rel = mission
  ? `.octobots/campaigns/${campaign}/missions/${mission}/workflows/${slug}`
  : `.octobots/campaigns/${campaign}/workflows/${slug}`;
console.log(`created ${rel}`);
