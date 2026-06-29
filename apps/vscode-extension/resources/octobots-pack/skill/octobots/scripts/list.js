#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".octobots", "campaigns");
const json = process.argv.includes("--json");
function title(file) {
  try { const m = readFileSync(file, "utf8").match(/^#\s+(.*)$/m); return m ? m[1].trim() : "(untitled)"; }
  catch { return "(untitled)"; }
}
function dirs(p) { return existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []; }

const tree = [];
for (const c of dirs(root)) {
  const cDir = join(root, c);
  const node = { campaign: title(join(cDir, "campaign.md")), path: `.octobots/campaigns/${c}`, missions: [] };
  for (const m of dirs(join(cDir, "missions"))) {
    const mDir = join(cDir, "missions", m);
    const mn = { mission: title(join(mDir, "mission.md")), path: `${node.path}/missions/${m}`, tasks: [] };
    for (const t of dirs(join(mDir, "tasks"))) mn.tasks.push({ task: title(join(mDir, "tasks", t, "task.md")), path: `${mn.path}/tasks/${t}` });
    node.missions.push(mn);
  }
  tree.push(node);
}

if (json) { console.log(JSON.stringify(tree, null, 2)); }
else if (tree.length === 0) { console.log("No campaigns under .octobots/."); }
else {
  for (const c of tree) {
    console.log(`# ${c.campaign}  (${c.path})`);
    for (const m of c.missions) {
      console.log(`  - ${m.mission}  (${m.path})`);
      for (const t of m.tasks) console.log(`      • ${t.task}  (${t.path})`);
    }
  }
}
