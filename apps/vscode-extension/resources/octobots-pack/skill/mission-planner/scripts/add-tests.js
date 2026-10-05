#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dumpEntity, readEntity, resolveEntityFile } from "./entity-io.mjs";

// Scaffold a mission's functional-test folder and link it: creates
// `<campaign>/tests/m<n>/README.md` (an AC map with one row per acceptance criterion plus the sections
// 'Shared preconditions', 'Pre-existing records' and 'Assumptions to confirm') and attaches the mission
// document "M<n> functional test cases" -> `.octobots/campaigns/<campaign>/tests/m<n>/README.md`.
// The TC file template is `templates/TC-template.md` in this skill; the README points at it.
//
// Usage:  add-tests.js <mission-dir|mission.yaml>
// Idempotent: a second run changes nothing. An existing README is NEVER overwritten (it is still linked
// when unlinked). The document link is idempotent on target, as add-doc.js's is.
// Exit codes: 0 done (or nothing to do); 2 usage error / path not found / not a mission / no M<n> id.
const arg = process.argv[2];
if (!arg) {
  console.error("usage: add-tests.js <mission-dir|mission.yaml>");
  process.exit(2);
}
if (!existsSync(arg)) { console.error(`add-tests: path not found: ${arg}`); process.exit(2); }

const resolved = resolveEntityFile(arg, ["mission"]);
if (!resolved) { console.error(`add-tests: not a mission directory or mission.yaml: ${arg}`); process.exit(2); }

const missionDir = dirname(resolved.file);
const fields = readEntity(resolved.file, resolved.format);
const idMatch = /^(M\d+[a-z]*)\b/i.exec(String(fields.name ?? "").trim());
if (!idMatch) {
  console.error(`add-tests: mission name must start with its id token M<n> (e.g. "M3 - ..."): ${fields.name ?? ""}`);
  process.exit(2);
}
const missionId = `M${idMatch[1].slice(1).toLowerCase()}`;
const folder = missionId.toLowerCase();

// <campaign>/missions/<mission>: the campaign dir is two levels up.
const missionsDir = dirname(missionDir);
if (basename(missionsDir) !== "missions") {
  console.error(`add-tests: a mission lives under <campaign>/missions/, not here: ${missionDir}`);
  process.exit(2);
}
const campaignDir = dirname(missionsDir);
const campaign = basename(campaignDir);

const readmePath = join(campaignDir, "tests", folder, "README.md");
const target = `.octobots/campaigns/${campaign}/tests/${folder}/README.md`;
const label = `${missionId} functional test cases`;

const cell = (s) => String(s).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const trunc = (s, n = 100) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function readme() {
  const rows = fields.acceptanceCriteria.map(
    (ac, i) => `| ${missionId}-AC${i + 1} | ${trunc(cell(ac.text))} |  |`,
  );
  return [
    `# Suite: ${campaign}-${folder}`,
    "",
    `Functional test cases for **${fields.name}**, campaign \`${campaign}\`. One case per file, \`TC-NNN_<slug>.md\`, authored with the mission before it is built. Start each case from \`.claude/skills/mission-planner/templates/TC-template.md\` (the TC format contract is in the mission-planner skill).`,
    "",
    "## AC to test case map",
    "",
    "| AC | Summary | Test cases |",
    "|----|---------|------------|",
    ...rows,
    "",
    "## Shared preconditions",
    "",
    "- ",
    "",
    "## Pre-existing records",
    "",
    "- ",
    "",
    "## Assumptions to confirm",
    "",
    "- ",
    "",
  ].join("\n");
}

const did = [];
if (existsSync(readmePath)) {
  did.push(`README exists, not overwritten: ${target}`);
} else {
  mkdirSync(dirname(readmePath), { recursive: true });
  writeFileSync(readmePath, readme(), "utf8");
  did.push(`created ${target} (${fields.acceptanceCriteria.length} AC rows)`);
}

if (fields.documents.some((d) => d.target === target)) {
  did.push(`doc already present: ${target}`);
} else {
  fields.documents.push({ label, target });
  writeFileSync(join(missionDir, `${resolved.kind}.yaml`), dumpEntity(resolved.kind, fields), "utf8");
  did.push(`added document: ${label} -> ${target}`);
}
console.log(did.join("\n"));
