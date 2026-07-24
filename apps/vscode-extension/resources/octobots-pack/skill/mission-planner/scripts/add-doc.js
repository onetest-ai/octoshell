#!/usr/bin/env node
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dumpEntity, readEntity, resolveEntityFile } from "./entity-io.mjs";

// Attach a document link to a campaign/mission's OWN `documents` list in its `<kind>.yaml` (a list of
// { label, target }). Idempotent on target. Documents attach to campaigns and missions only — task/bug
// entities have no documents. Targets are typically repo-relative paths or URLs.
const arg = process.argv[2];
const label = (process.argv[3] ?? "").trim();
const target = (process.argv[4] ?? "").trim();
if (!arg || !label || !target) {
  console.error('usage: add-doc.js <campaign-dir|mission-dir|entity.yaml> "<label>" <target>');
  process.exit(2);
}
if (!existsSync(arg)) { console.error(`add-doc: path not found: ${arg}`); process.exit(2); }

// Resolve to a campaign or mission entity file. A directory prefers campaign/mission; a task/bug file
// (or a folder that only holds one) is rejected — documents attach to campaigns and missions only.
const anyKind = resolveEntityFile(arg, ["campaign", "mission", "task", "bug"]);
if (anyKind && (anyKind.kind === "task" || anyKind.kind === "bug")) {
  console.error("add-doc: documents attach to campaigns and missions only (not task/bug entities)");
  process.exit(2);
}
const resolved = statSync(arg).isDirectory() ? resolveEntityFile(arg, ["campaign", "mission"]) : anyKind;
if (!resolved || (resolved.kind !== "campaign" && resolved.kind !== "mission")) {
  console.error("add-doc: documents attach to campaigns and missions only (not task/bug entities)");
  process.exit(2);
}

const fields = readEntity(resolved.file, resolved.format);
if (fields.documents.some((d) => d.target === target)) {
  console.log(`doc already present: ${target}`);
  process.exit(0);
}
fields.documents.push({ label, target });
writeFileSync(join(dirname(resolved.file), `${resolved.kind}.yaml`), dumpEntity(resolved.kind, fields), "utf8");
console.log(`added document: ${label} -> ${target}`);
