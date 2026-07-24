#!/usr/bin/env node
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { childDirs, dumpEntity, entityName, mapBoardStatus, readEntity, resolveEntityFile } from "./entity-io.mjs";

// Set an entity's status in its OWN `<kind>.yaml` — status is a field in the child's file, never a
// marker on a parent board line (children are folder-derived). Resolve the target by name within the
// given parent folder: the parent itself (campaign/mission self-status), or a child under
// missions/ | tasks/ | bugs/.
//
// Usage: set-status.js <parent-dir|entity.yaml> "<entity title>" <state>
//   <state>  draft | active | executing | awaiting approval | done | failed | cancelled
const [arg, rawTitle, ...stateParts] = process.argv.slice(2);
const title = (rawTitle ?? "").trim();
const state = stateParts.join(" ").trim();
if (!arg || !title || !state) {
  console.error('usage: set-status.js <parent-dir|entity.yaml> "<entity title>" <state>');
  console.error("  state: draft | active | executing | awaiting approval | done | failed | cancelled");
  process.exit(2);
}

const mapped = mapBoardStatus(state);
if (!mapped) {
  console.error(`set-status: invalid state "${state}" (expected one of: draft, active, executing, awaiting approval, done, failed, cancelled)`);
  process.exit(2);
}
if (!existsSync(arg)) { console.error(`set-status: path not found: ${arg}`); process.exit(2); }

const parentDir = statSync(arg).isDirectory() ? arg : dirname(arg);
const titleKey = title.toLowerCase();

// Build the candidate list: the parent entity itself (self-status), then children by folder scan.
const candidates = [];
const self = resolveEntityFile(parentDir);
if (self) candidates.push({ dir: parentDir, kind: self.kind });
for (const [sub, kind] of [["missions", "mission"], ["tasks", "task"], ["bugs", "bug"]]) {
  for (const slug of childDirs(join(parentDir, sub))) candidates.push({ dir: join(parentDir, sub, slug), kind });
}

const match = candidates.find((c) => entityName(c.dir, c.kind).toLowerCase() === titleKey);
if (!match) {
  console.error(`set-status: no entity named "${title}" found under ${parentDir} (self, missions/, tasks/, or bugs/)`);
  process.exit(1);
}

const resolved = resolveEntityFile(match.dir, [match.kind]);
const fields = readEntity(resolved.file, resolved.format);
fields.status = mapped;
writeFileSync(join(match.dir, `${match.kind}.yaml`), dumpEntity(match.kind, fields), "utf8");
console.log(`set status of "${title}" to ${mapped}`);
