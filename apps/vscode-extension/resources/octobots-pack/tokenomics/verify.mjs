#!/usr/bin/env node
// Cross-check our totals against ccusage - an independent reader of the same
// transcripts. This is the guard that keeps the pipeline honest: if our
// collector starts missing a transcript location (as it did with Workflow-tool
// agents under `subagents/workflows/`), cost and token totals drift and this
// fails loudly instead of quietly under-reporting.
//
//   node .octobots/tokenomics/verify.mjs              # fail if cost or tokens deviate > 10%
//   node .octobots/tokenomics/verify.mjs --tolerance 5
//
// Population: exactly the one collect.mjs reads - THIS project's slug directory under the same
// roots (`$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, plus the legacy repo-local
// `.claude/projects`). ccusage has no project filter and does not follow a symlinked slug dir, so
// we hand it each root that holds our slug dir (staged as a `projects` symlink in a temp dir; it
// reads every project there) and keep only the sessions found in our slug dirs. Runs ccusage
// offline from the workspace's installed copy; `npx` is only the fallback when that copy is
// absent, and only then can the network matter.
//
// Usage: node .octobots/tokenomics/verify.mjs [--tolerance PCT] [--project-dir DIR]

import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { locateTranscripts } from "./roots.mjs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : dflt;
};

const TOLERANCE = Number(argOf("--tolerance", "10"));
const CCUSAGE = argOf("--ccusage", "ccusage@20.0.18");

// The same population rule collect.mjs reads (roots, slug, worktree unwinding): one shared module.
// Artifacts live in the current checkout; transcripts only under the main one's slug.
const { projectDir: PROJECT_DIR, mainDir: MAIN_DIR, slug: PROJECT_SLUG, roots: ROOTS } = locateTranscripts(args);

const TOK_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");
const runsFile = join(TOK_DIR, "runs.json");
const segFile = join(TOK_DIR, "raw", "segments.jsonl");
for (const f of [runsFile, segFile]) {
  if (!existsSync(f)) {
    console.error(`tokenomics: ${f} missing - run \`node .octobots/tokenomics/run.mjs\` first`);
    process.exit(1);
  }
}
const d = JSON.parse(readFileSync(runsFile, "utf8"));

// Our population: the sessions whose transcripts sit in our own slug dirs, per root.
const present = ROOTS.filter((r) => {
  try { return statSync(join(r, PROJECT_SLUG)).isDirectory(); } catch { return false; }
});
if (present.length === 0) {
  console.error(`tokenomics: no transcripts for slug ${PROJECT_SLUG} under ${ROOTS.join(", ")} - nothing to cross-check`);
  process.exit(2);
}
// ccusage `session` keys a row by the transcript's PATH, not its records' sessionId (probed on
// 20.0.18): `<slug>/<sid>.jsonl` and `<sid>/subagents/*.jsonl` give row `<sid>`, but a deeper file
// gives a row named after the dir holding it - a Workflow-tool agent at
// `<sid>/subagents/workflows/wf_<id>/` is its own `wf_<id>` row. collect.mjs folds all of those into
// `<sid>`, so our population's ccusage keys are the session ids (S) plus those dir names (K).
const S = new Set();
const K = new Set();
function nestedKeys(dir, isSubagentsRoot) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) nestedKeys(join(dir, e.name), false);
    else if (!isSubagentsRoot && e.name.endsWith(".jsonl")) K.add(basename(dir));
  }
}
const rootCounts = [];
for (const r of present) {
  let n = 0;
  for (const e of readdirSync(join(r, PROJECT_SLUG))) {
    if (!e.endsWith(".jsonl")) continue;
    const id = e.slice(0, -6);
    S.add(id);
    n++;
    nestedKeys(join(r, PROJECT_SLUG, id, "subagents"), true);
  }
  rootCounts.push(`${r} (${n})`);
}

// Our side. Tokens come from segments.jsonl filtered to the same sessions: it keeps sessions whose
// transcripts were pruned, so the comparison stays like-for-like. Cost is runs.json's total, which
// prices every segment, so it is only comparable while no collected session has vanished from disk.
const ours = { input: 0, output: 0, cache_create: 0, cache_read: 0, cost: 0 };
const collected = new Set();
for (const line of readFileSync(segFile, "utf8").split("\n")) {
  if (!line) continue;
  let s;
  try { s = JSON.parse(line); } catch { continue; }
  collected.add(s.session_id);
  if (!S.has(s.session_id)) continue;
  for (const m of Object.values(s.tokens_by_model ?? {})) {
    ours.input += m.input_tokens ?? 0;
    ours.output += m.output_tokens ?? 0;
    ours.cache_read += m.cache_read_input_tokens ?? 0;
    ours.cache_create += m.cache_creation_input_tokens ?? 0;
  }
}
for (const r of d.runs ?? []) ours.cost += r.cost_api_equivalent_usd;
ours.cost += d.unattributed?.cost_api_equivalent_usd ?? 0;
// Our cost per model (runs + the unattributed bucket), keyed by the normalised model id, so the
// models ccusage cannot price can be taken out of the cost comparison.
const normModel = (m) => String(m).replace(/\[.*$/, "").replace(/-\d{8}$/, "");
const oursCostByModel = {};
for (const src of [...(d.runs ?? []), d.unattributed ?? {}]) {
  for (const [m, c] of Object.entries(src.cost_by_model ?? {})) {
    oursCostByModel[normModel(m)] = (oursCostByModel[normModel(m)] ?? 0) + c;
  }
}
const vanished = [...collected].filter((id) => !S.has(id)).length;

// ccusage side. Stage each present slug dir's parent as `<tmp>/r<i>/projects`: a symlink named
// `projects` is followed by ccusage, whereas a symlinked slug dir inside a root is not.
const tmp = mkdtempSync(join(tmpdir(), "octobots-verify-"));
let raw;
try {
  const parents = [...new Set(present.map((r) => dirname(realpathSync(join(r, PROJECT_SLUG)))))];
  const staged = parents.map((p, i) => {
    const dir = join(tmp, `r${i}`);
    mkdirSync(dir);
    symlinkSync(p, join(dir, "projects"));
    return dir;
  });
  // Prefer the workspace's installed copy (.octobots/tools): `npx` re-resolves the package on every
  // call (823ms against 29ms). OCTOBOTS_CCUSAGE_BIN overrides it (tests, custom installs).
  const localCcusage = join(MAIN_DIR, ".octobots", "tools", "node_modules", ".bin", "ccusage");
  const bin = process.env.OCTOBOTS_CCUSAGE_BIN || (existsSync(localCcusage) ? localCcusage : null);
  const viaNpx = !bin;
  const [cmd, prefix] = viaNpx
    ? ["npx", ["-y", CCUSAGE]]
    : /\.(mjs|js)$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
  try {
    raw = execFileSync(cmd, [...prefix, "session", "--json", "--offline"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: staged.join(",") },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
  } catch (err) {
    const first = String(err.stderr || err.message).split("\n").find((l) => l.trim()) ?? "unknown error";
    rmSync(tmp, { recursive: true, force: true }); // process.exit skips `finally`
    console.error(viaNpx
      ? `tokenomics: could not run ccusage via npx (first use needs network): ${first}`
      : `tokenomics: ccusage failed: ${first}`);
    process.exit(2);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const cc = { input: 0, output: 0, cache_create: 0, cache_read: 0, cost: 0 };
const parsed = JSON.parse(raw);
const rows = parsed.session ?? parsed.sessions ?? parsed.data ?? [];
let matched = 0;
const ccByModel = {}; // normalised model -> { tokens, cost } over the rows in our population
for (const r of rows) {
  if (!(S.has(r.period) || K.has(r.period)) || (r.agent && r.agent !== "claude")) continue;
  if (S.has(r.period)) matched++;
  cc.input += r.inputTokens ?? 0;
  cc.output += r.outputTokens ?? 0;
  cc.cache_create += r.cacheCreationTokens ?? 0;
  cc.cache_read += r.cacheReadTokens ?? 0;
  cc.cost += r.totalCost ?? 0;
  for (const b of r.modelBreakdowns ?? []) {
    const m = (ccByModel[normModel(b.modelName)] ??= { tokens: 0, cost: 0 });
    m.tokens += (b.inputTokens ?? 0) + (b.outputTokens ?? 0) + (b.cacheCreationTokens ?? 0) + (b.cacheReadTokens ?? 0);
    m.cost += b.cost ?? 0;
  }
}

// A model ccusage reports tokens for but $0 cost is one it has no price for (its bundled table can
// predate a model family). Cost over such a model says nothing about our collector, so it leaves
// the cost gate; token lines are unaffected.
const unpriced = Object.entries(ccByModel).filter(([, m]) => m.tokens > 0 && m.cost === 0).map(([k]) => k).sort();
const pricedModels = Object.entries(ccByModel).filter(([, m]) => m.tokens > 0 && m.cost > 0);
let costNote = null;
let costGated = vanished === 0;
if (unpriced.length > 0) {
  if (pricedModels.length === 0) {
    costGated = false;
    costNote = `cost: info (ccusage has no price for ${unpriced.join(", ")})`;
  } else {
    // Compare over the priced models only: drop the unpriced models' cost from our total.
    for (const u of unpriced) ours.cost -= oursCostByModel[u] ?? 0;
    costNote = `cost: gated over priced models only (ccusage has no price for ${unpriced.join(", ")})`;
  }
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
  ["cost (USD)", ours.cost, cc.cost, costGated],
  ["total tokens", oursTotal, ccTotal, true],
  ["cache_read", ours.cache_read, cc.cache_read, true],
  ["cache_create", ours.cache_create, cc.cache_create, true],
  ["input", ours.input, cc.input, false],
  ["output", ours.output, cc.output, false],
];

console.log(`tokenomics: cross-check vs ${CCUSAGE} (tolerance ${TOLERANCE}%)`);
console.log(`  roots: ${rootCounts.join("; ")}; ccusage sessions matched: ${matched}/${S.size}\n`);
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
if (costNote) console.log(`  ${costNote}\n`);
if (vanished) console.log(`${vanished} session(s) in segments.jsonl are no longer on disk - cost not comparable (shown as info).\n`);
if (failed) {
  console.log(`${failed} gated field(s) outside ${TOLERANCE}% — investigate the COLLECTOR first.`);
  console.log("A missed transcript location is the usual cause; ccusage reads the same files.");
  process.exit(1);
}
console.log(`all gated fields within ${TOLERANCE}% of ccusage`);
