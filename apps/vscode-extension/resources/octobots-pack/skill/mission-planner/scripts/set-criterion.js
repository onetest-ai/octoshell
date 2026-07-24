#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpEntity, readEntity, resolveEntityFile } from "./entity-io.mjs";

// Edit an entity's OWN `acceptance_criteria` list in its `<kind>.yaml` (a list of { text, done }).
//   set-criterion.js <entity-dir|entity.yaml> add "<text>" | check <n> | uncheck <n>
// Applies to campaigns, missions, and tasks (bugs have no acceptance criteria).
const [arg, op, opArg] = process.argv.slice(2);
if (!arg || !existsSync(arg) || !op) {
  console.error('usage: set-criterion.js <entity-dir|entity.yaml> add "<text>" | check <n> | uncheck <n>');
  process.exit(2);
}
const resolved = resolveEntityFile(arg, ["campaign", "mission", "task"]);
if (!resolved) {
  console.error("set-criterion: not a campaign/mission/task entity file (bugs have no acceptance criteria)");
  process.exit(2);
}
const fields = readEntity(resolved.file, resolved.format);
const list = fields.acceptanceCriteria;

if (op === "add") {
  const text = (opArg ?? "").trim();
  if (!text) { console.error("set-criterion add: missing text"); process.exit(2); }
  list.push({ text, done: false });
} else if (op === "check" || op === "uncheck") {
  const n = Number(opArg);
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    console.error(`set-criterion: index out of range (1..${list.length})`);
    process.exit(2);
  }
  list[n - 1].done = op === "check";
} else {
  console.error(`set-criterion: unknown op '${op}'`);
  process.exit(2);
}

// Always persist as YAML in the entity folder (migrating a legacy .md on edit).
writeFileSync(join(dirname(resolved.file), `${resolved.kind}.yaml`), dumpEntity(resolved.kind, fields), "utf8");
console.log(`acceptance criteria updated (${op})`);
