#!/usr/bin/env node
// Cross-check our totals against ccusage — an independent reader of the same
// transcripts. This is the guard that keeps the pipeline honest: if our
// collector starts missing a transcript location (as it did with Workflow-tool
// agents under `subagents/workflows/`), cost and token totals drift and this
// fails loudly instead of quietly under-reporting.
//
//   node .octobots/tokenomics/verify.mjs              # fail if cost or tokens deviate > 10%
//   node .octobots/tokenomics/verify.mjs --tolerance 5
//
// Requires network (runs ccusage via npx), so it is NOT part of the mission
// gate — run it when the collector changes, or periodically.
//
// Usage: node .octobots/tokenomics/verify.mjs [--tolerance PCT] [--project-dir DIR]

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : dflt;
};

const TOLERANCE = Number(argOf("--tolerance", "10"));
const PROJECT_DIR = argOf("--project-dir", process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const CCUSAGE = argOf("--ccusage", "ccusage@20.0.18");

// Artifacts live in the current checkout; transcripts only in the main one.
const wt = PROJECT_DIR.indexOf("/.claude/worktrees/");
const MAIN_DIR = wt !== -1 ? PROJECT_DIR.slice(0, wt) : PROJECT_DIR;
const TOK_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");

const runsFile = join(TOK_DIR, "runs.json");
if (!existsSync(runsFile)) {
  console.error(`tokenomics: ${runsFile} missing — run \`node .octobots/tokenomics/run.mjs\` first`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(runsFile, "utf8"));

// Our whole-repo totals = every mission row + the unattributed bucket, which is
// the same population ccusage reads.
const ours = { input: 0, output: 0, cache_create: 0, cache_read: 0, cost: 0 };
for (const r of d.runs ?? []) {
  ours.input += r.tokens.input;
  ours.output += r.tokens.output;
  ours.cache_create += r.tokens.cache_create;
  ours.cache_read += r.tokens.cache_read;
  ours.cost += r.cost_api_equivalent_usd;
}
ours.cost += d.unattributed?.cost_api_equivalent_usd ?? 0;
for (const [k, v] of Object.entries(d.unattributed?.tokens ?? {})) ours[k] += v;

let raw;
try {
  // Prefer the workspace's installed copy (.octobots/tools), which the pack installs ONCE. `npx`
  // re-resolves the package on every call — measured at 823ms against 29ms for the local binary,
  // and this pipeline calls it repeatedly. The npx path stays as the fallback so a workspace that
  // declined the tools install (or installed offline) still works, just slowly.
  const localCcusage = join(MAIN_DIR, ".octobots", "tools", "node_modules", ".bin", "ccusage");
  const [cmd, prefix] = existsSync(localCcusage) ? [localCcusage, []] : ["npx", ["-y", CCUSAGE]];
  raw = execFileSync(cmd, [...prefix, "daily", "--json"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(MAIN_DIR, ".claude") },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 180000,
  });
} catch (err) {
  console.error(`tokenomics: could not run ccusage (${err.message.split("\n")[0]})`);
  console.error("tokenomics: verification skipped — this needs network access.");
  process.exit(2);
}

const cc = { input: 0, output: 0, cache_create: 0, cache_read: 0, cost: 0 };
const rows = JSON.parse(raw).daily ?? JSON.parse(raw).data ?? [];
for (const r of rows) {
  cc.input += r.inputTokens ?? 0;
  cc.output += r.outputTokens ?? 0;
  cc.cache_create += r.cacheCreationTokens ?? 0;
  cc.cache_read += r.cacheReadTokens ?? 0;
  cc.cost += r.totalCost ?? 0;
}

const oursTotal = ours.input + ours.output + ours.cache_create + ours.cache_read;
const ccTotal = cc.input + cc.output + cc.cache_create + cc.cache_read;
const dev = (a, b) => (b === 0 ? (a === 0 ? 0 : 100) : Math.abs(a - b) / b * 100);
const fmt = (n) => n.toLocaleString("en-US");

// Gate on cost and total tokens. `input` and `output` are reported but not
// gated, for reasons that are understood and stable:
//   * input  — ccusage also counts non-Claude agents (e.g. Codex); we read
//              Claude transcripts only. The absolute size is negligible.
//   * output — ccusage's total matches top-level output PLUS
//              usage.iterations[] output. `iterations` restates the same
//              request per attempt rather than adding generation, so summing
//              both double-counts. We count the top-level figure only.
const GATED = [
  ["cost (USD)", ours.cost, cc.cost, true],
  ["total tokens", oursTotal, ccTotal, true],
  ["cache_read", ours.cache_read, cc.cache_read, true],
  ["cache_create", ours.cache_create, cc.cache_create, true],
  ["input", ours.input, cc.input, false],
  ["output", ours.output, cc.output, false],
];

console.log(`tokenomics: cross-check vs ${CCUSAGE} (tolerance ${TOLERANCE}%)\n`);
console.log(`  ${"field".padEnd(14)}${"ours".padStart(18)}${"ccusage".padStart(18)}${"dev".padStart(9)}`);

let failed = 0;
for (const [name, o, c, gated] of GATED) {
  const pct = dev(o, c);
  const ok = !gated || pct <= TOLERANCE;
  if (!ok) failed++;
  const shown = name === "cost (USD)" ? [`$${o.toFixed(2)}`, `$${c.toFixed(2)}`] : [fmt(o), fmt(c)];
  const mark = gated ? (ok ? "ok  " : "FAIL") : "info";
  console.log(`  ${mark} ${name.padEnd(14 - 5)}${shown[0].padStart(18)}${shown[1].padStart(18)}${(pct.toFixed(2) + "%").padStart(9)}`);
}

console.log();
if (failed) {
  console.log(`${failed} gated field(s) outside ${TOLERANCE}% — investigate the COLLECTOR first.`);
  console.log("A missed transcript location is the usual cause; ccusage reads the same files.");
  process.exit(1);
}
console.log(`all gated fields within ${TOLERANCE}% of ccusage`);
