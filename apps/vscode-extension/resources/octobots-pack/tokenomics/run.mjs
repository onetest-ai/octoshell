#!/usr/bin/env node
// octobots-pack-version: 38
// Tokenomics pipeline runner — collect -> rollup -> render, in one call.
//
// This is what the mission-completion gate invokes. It is deliberately
// NON-BLOCKING: the gate is a correctness gate (tests, QA, review) and must
// never fail a mission because analytics could not be produced. Any stage that
// throws is reported and the runner still exits 0.
//
// Usage: node .octobots/tokenomics/run.mjs [--no-gh] [--quiet] [--strict]

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const passthrough = args.filter((a) => a !== "--strict");

const stages = [
  ["collect", "collect.mjs"],
  ["rollup", "rollup.mjs"],
  ["render", "render.mjs"],
];

let failed = null;
for (const [name, script] of stages) {
  try {
    execFileSync(process.execPath, [join(HERE, script), ...passthrough], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (err) {
    failed = name;
    console.error(`tokenomics: stage '${name}' failed — ${err.message.split("\n")[0]}`);
    break;
  }
}

if (failed) {
  console.error(
    "tokenomics: pipeline incomplete. This does NOT block the mission gate — " +
    "re-run `node .octobots/tokenomics/run.mjs` once the cause is fixed.",
  );
  process.exit(strict ? 1 : 0);
}
