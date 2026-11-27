#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { dumpEntity, readEntity, resolveEntityFile } from "./entity-io.mjs";
import { headCommit, HEADINGS, repoRootOf, trackedChanges } from "./completion-guard.mjs";

// Write the `## Completion gate (<ISO>)` record into a mission's notes from the agent's QA and review
// results. This script is the only writer of that record, so no agent writes its text by hand.
//
// Usage: gate-record.mjs <mission-dir|mission.yaml> --verdict green|red|pending-human
//          --qa <n>/<m> --still-open <k> [--note <text>]...
//
// `--verdict green` is refused unless n = m = the mission's current acceptance-criterion count and k = 0.
// Exit codes: 0 written, 2 usage, 3 refused (not a git repository, tracked changes outside the board,
// or a green verdict the counts do not support).
const USAGE = "usage: gate-record.mjs <mission-dir|mission.yaml> --verdict green|red|pending-human --qa <n>/<m> --still-open <k> [--note <text>]...";
const usage = (msg) => {
  if (msg) console.error(`gate-record: ${msg}`);
  console.error(USAGE);
  process.exit(2);
};
const refuse = (msg) => {
  console.error(`gate-record: refusing: ${msg}`);
  process.exit(3);
};

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      verdict: { type: "string" },
      qa: { type: "string" },
      "still-open": { type: "string" },
      note: { type: "string", multiple: true },
    },
  });
} catch (e) {
  usage(String(e.message).split("\n")[0]);
}
const { values, positionals } = parsed;
const [arg] = positionals;
if (!arg || positionals.length > 1) usage("expected exactly one mission path");
if (!["green", "red", "pending-human"].includes(values.verdict ?? "")) usage("--verdict must be green, red or pending-human");
const qa = /^(\d+)\/(\d+)$/.exec(values.qa ?? "");
if (!qa) usage("--qa must read <n>/<m>");
if (!/^\d+$/.test(values["still-open"] ?? "")) usage("--still-open must be a non-negative integer");
const passed = Number(qa[1]);
const total = Number(qa[2]);
const stillOpen = Number(values["still-open"]);
const verdict = values.verdict;
if (!existsSync(arg)) usage(`path not found: ${arg}`);

const resolved = resolveEntityFile(arg, ["mission"]);
if (!resolved) usage(`no mission found at ${arg}`);
const missionDir = dirname(resolved.file);
const fields = readEntity(resolved.file, resolved.format);

const repoRoot = repoRootOf(missionDir);
if (!repoRoot) refuse("the mission is not in a git repository, so the record cannot name a commit");
let dirty;
let commit;
try {
  dirty = trackedChanges(repoRoot, missionDir);
  commit = headCommit(repoRoot);
} catch (e) {
  refuse(`git failed: ${String(e.message).split("\n")[0]}`);
}
if (dirty.length) {
  refuse(`tracked changes outside the board; commit or stash them first, so the record names the tested commit:\n${dirty.map((l) => `  ${l}`).join("\n")}`);
}

if (verdict === "green") {
  const criteria = Array.isArray(fields.acceptanceCriteria) ? fields.acceptanceCriteria.length : 0;
  const off = [];
  if (passed !== criteria) off.push(`${passed} criteria passed, but the mission has ${criteria}`);
  if (total !== criteria) off.push(`${qa[0]} counts ${total} criteria, but the mission has ${criteria}`);
  if (stillOpen !== 0) off.push(`stillOpen=${stillOpen}, but a green verdict needs stillOpen=0`);
  if (off.length) refuse(`a green verdict does not match the mission (QA ${qa[0]}):\n${off.map((l) => `  ${l}`).join("\n")}`);
}

const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const record = [
  `## ${HEADINGS.completion} (${at})`,
  `Verdict: ${verdict}`,
  `Commit: ${commit}`,
  `QA: ${passed}/${total} criteria passed`,
  `Review: stillOpen=${stillOpen}`,
  ...(values.note ?? []).map((n) => `Note: ${n.replace(/\s+/g, " ").trim()}`),
].join("\n");
const old = fields.notes ?? "";
fields.notes = old ? `${old}${old.endsWith("\n") ? "\n" : "\n\n"}${record}` : record;
writeFileSync(join(missionDir, "mission.yaml"), dumpEntity("mission", fields), "utf8");
console.log(record);
