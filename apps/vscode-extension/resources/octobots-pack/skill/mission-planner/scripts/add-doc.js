#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Attach a document link to a campaign/mission board's `## Documents` section. The link round-trips:
// the app parses `- [label](target)` lines back into link resources (see project-daemon
// reconcileDocumentLinks), so this is the agent-driveable way to attach a spec/plan/design without
// touching the managed header by hand. Targets are typically repo-relative paths (e.g. a superpowers
// spec under docs/superpowers/specs/) or URLs.
const arg = process.argv[2];
const label = (process.argv[3] ?? "").trim();
const target = (process.argv[4] ?? "").trim();
if (!arg || !label || !target) {
  console.error('usage: add-doc.js <campaign.md|mission.md|entity-dir> "<label>" <target>');
  process.exit(2);
}
let path = arg;
if (existsSync(arg) && statSync(arg).isDirectory()) {
  for (const name of ["campaign.md", "mission.md"]) {
    if (existsSync(join(arg, name))) { path = join(arg, name); break; }
  }
}
if (!existsSync(path)) { console.error(`add-doc: file not found: ${path}`); process.exit(2); }

let text = readFileSync(path, "utf8");
const head = /^##\s+Documents\s*$/m.exec(text);
if (!head) {
  console.error("add-doc: no `## Documents` section found (campaign and mission boards only)");
  process.exit(2);
}
const bodyStart = head.index + head[0].length;
const rest = text.slice(bodyStart);
const nextRel = rest.search(/^(##\s+|<!--)/m);
const cut = nextRel >= 0 ? bodyStart + nextRel : text.length;
let body = text.slice(bodyStart, cut);

if (body.includes(`(${target})`)) { // idempotent: never duplicate a target
  console.log(`doc already present: ${target}`);
  process.exit(0);
}

const line = `- [${label}](${target})`;
const placeholder = "_(none)_";
body = body.includes(placeholder) ? body.replace(placeholder, line) : `${body.replace(/\s+$/, "")}\n${line}\n`;
writeFileSync(path, text.slice(0, bodyStart) + body + text.slice(cut), "utf8");
console.log(`added document: ${label} -> ${target}`);
