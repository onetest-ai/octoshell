#!/usr/bin/env node
import { join } from "node:path";
import { childDirs, entityName } from "./entity-io.mjs";

// Print the campaign → mission → task tree from disk. Titles come from each entity's `<kind>.yaml`
// (falling back to a legacy `<kind>.md` heading); children are folder-derived by scanning subdirs.
const root = join(process.cwd(), ".octobots", "campaigns");
const json = process.argv.includes("--json");
const nameOf = (dir, kind) => entityName(dir, kind) || "(untitled)";

const tree = [];
for (const c of childDirs(root)) {
  const cDir = join(root, c);
  const node = { campaign: nameOf(cDir, "campaign"), path: `.octobots/campaigns/${c}`, missions: [] };
  for (const m of childDirs(join(cDir, "missions"))) {
    const mDir = join(cDir, "missions", m);
    const mn = { mission: nameOf(mDir, "mission"), path: `${node.path}/missions/${m}`, tasks: [] };
    for (const t of childDirs(join(mDir, "tasks"))) {
      mn.tasks.push({ task: nameOf(join(mDir, "tasks", t), "task"), path: `${mn.path}/tasks/${t}` });
    }
    node.missions.push(mn);
  }
  tree.push(node);
}

if (json) {
  console.log(JSON.stringify(tree, null, 2));
} else if (tree.length === 0) {
  console.log("No campaigns under .octobots/.");
} else {
  for (const c of tree) {
    console.log(`# ${c.campaign}  (${c.path})`);
    for (const m of c.missions) {
      console.log(`  - ${m.mission}  (${m.path})`);
      for (const t of m.tasks) console.log(`      • ${t.task}  (${t.path})`);
    }
  }
}
