#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpEntity, readEntity, resolveEntityFile } from "./entity-io.mjs";
import { headCommit, HEADINGS, repoRootOf, trackedChanges } from "./completion-guard.mjs";
import { parseTestLanes } from "./lanes.mjs";

// Run the mechanical part of the mission completion gate (the coverage lane from AGENTS.md
// § Test lanes, then the parked-test scan) and write the `## Gate checks (<ISO>)` record into the
// mission's notes. This script is the only writer of that record. The write is the last step, so a
// run killed before it writes nothing.
//
// Usage: gate-checks.mjs <mission-dir|mission.yaml>
// Exit codes: 0 green, 1 red, 2 usage, 3 refused (not a git repository, or tracked changes outside
// the board).
const USAGE = "usage: gate-checks.mjs <mission-dir|mission.yaml>";
const usage = (msg) => {
  if (msg) console.error(`gate-checks: ${msg}`);
  console.error(USAGE);
  process.exit(2);
};
const refuse = (msg) => {
  console.error(`gate-checks: refusing: ${msg}`);
  process.exit(3);
};

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith("-")) usage("expected exactly one mission path");
const [arg] = args;
if (!existsSync(arg)) usage(`path not found: ${arg}`);
const resolved = resolveEntityFile(arg, ["mission"]);
if (!resolved) usage(`no mission found at ${arg}`);
const missionDir = dirname(resolved.file);

const repoRoot = repoRootOf(missionDir);
if (!repoRoot) refuse("the mission is not in a git repository, so the record cannot name a commit; use set-status.js --force=<reason> instead");
let commit;
try {
  const dirty = trackedChanges(repoRoot, missionDir);
  if (dirty.length) {
    refuse(`tracked changes outside the board; commit or stash your changes first, a record taken now could never be current:\n${dirty.map((l) => `  ${l}`).join("\n")}`);
  }
  commit = headCommit(repoRoot);
} catch (e) {
  refuse(`git failed: ${String(e.message).split("\n")[0]}`);
}

// The lane: the `coverage` command, unless it is missing or still holds a <placeholder>.
let command = null;
try {
  const lanes = parseTestLanes(readFileSync(join(repoRoot, "AGENTS.md"), "utf8"));
  if (lanes.coverage && !/<[^>]*>/.test(lanes.coverage)) command = lanes.coverage;
} catch {
  // no AGENTS.md: no lane
}
let exit = "skipped";
if (command === null) {
  console.error("gate-checks: warning: no usable coverage lane in AGENTS.md § Test lanes; running the parked-test scan only");
} else {
  const lane = spawnSync("sh", ["-c", command], { cwd: repoRoot, stdio: "inherit" });
  exit = String(lane.status ?? (lane.signal ? `signal ${lane.signal}` : "error"));
}

// The parked-test scan, from the sibling mission-execution skill.
const scan = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mission-execution", "scripts", "scan-parked.js");
let parked = "error";
const s = spawnSync(process.execPath, [scan, "--json", "--root", repoRoot], { encoding: "utf8" });
if (s.status === 0 || s.status === 1) {
  try {
    const unsigned = JSON.parse(s.stdout).unsigned;
    if (Array.isArray(unsigned)) parked = `${unsigned.length} unsigned`;
  } catch {
    // unparseable output stays "error"
  }
}

let green = (command === null || exit === "0") && parked === "0 unsigned";
let moved = false;
try {
  moved = headCommit(repoRoot) !== commit || trackedChanges(repoRoot, missionDir).length > 0;
} catch {
  moved = true;
}
if (moved) green = false;

const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const record = [
  `## ${HEADINGS.gate} (${at})`,
  `Verdict: ${green ? "green" : "red"}`,
  `Commit: ${commit}`,
  command === null ? "Lane: none, no coverage lane in AGENTS.md § Test lanes" : `Lane: coverage \`${command}\``,
  `Exit: ${exit}`,
  `Parked: ${parked}`,
  ...(moved ? ["Note: the code changed during the run"] : []),
].join("\n");

const fields = readEntity(resolved.file, resolved.format);
const old = fields.notes ?? "";
fields.notes = old ? `${old}${old.endsWith("\n") ? "\n" : "\n\n"}${record}` : record;
writeFileSync(join(missionDir, "mission.yaml"), dumpEntity("mission", fields), "utf8");
console.log(record);
process.exit(green ? 0 : 1);
