#!/usr/bin/env node
// Refresh the cached LiteLLM price table.
//
//   node .octobots/tokenomics/update-prices.mjs          # refresh prices.json, then commit it
//   node .octobots/tokenomics/update-prices.mjs --check   # report drift, write nothing
//   node .octobots/tokenomics/update-prices.mjs --family openai   # refresh ONLY the Codex (gpt-*) rows
//                                                                 # (or `claude`); the other family is kept as cached
//
// Run this manually, occasionally — when models change or prices move. The
// pipeline never fetches: `prices.json` is a cached artifact, so collect /
// rollup / render stay offline, deterministic, and reproducible. Because every
// cost is recomputed from raw tokens, refreshing this file and re-running the
// rollup re-prices all historical runs under the new table.
//
// Entries are cached VERBATIM from upstream — same field names, same per-token
// units, no re-derivation. There is no local price schema to drift out of sync,
// and any number in `prices.json` can be diffed straight against LiteLLM.
//
// This script rewrites ONLY `prices.json`. Models upstream does not list yet live in the
// workspace-owned `prices.local.json`, which rollup.mjs reads alongside it (upstream wins on a
// conflict); a refresh never touches that file.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "prices.json");
const cliArgs = process.argv.slice(2);
// --help prints usage and exits before the script reads or writes anything.
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  console.log("Usage: node .octobots/tokenomics/update-prices.mjs [--check] [--family all|claude|openai]");
  process.exit(0);
}
const checkOnly = cliArgs.includes("--check");
const famIdx = cliArgs.indexOf("--family");
const FAMILY = famIdx !== -1 ? cliArgs[famIdx + 1] : "all"; // all | claude | openai
if (!["all", "claude", "openai"].includes(FAMILY)) {
  console.error(`tokenomics: unknown --family ${FAMILY} (all | claude | openai)`);
  process.exit(1);
}

// The cost fields we keep, under upstream's own names.
const COST_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
];

// Only first-party Anthropic ids — the same strings that appear as
// `message.model` in a transcript. Regional (`us.`/`eu.`/`au.`/`jp.`) and
// provider-prefixed (`anthropic.`, `vertex_ai/`, `bedrock/`) variants price
// differently and would silently shadow the first-party rate.
const isFirstPartyClaude = (id, e) =>
  /^claude-/.test(id) && e?.litellm_provider === "anthropic" && e?.mode === "chat";

// First-party OpenAI ids as the Codex CLI reports them in `turn_context.model`
// (gpt-6.1-sol, gpt-6-astra, gpt-6.1-terra, ...): generation 5.6 and up, provider
// `openai`. Azure/regional/reseller variants (`azure/…`, `chatgpt/…`) are skipped
// for the same reason as the Claude ones. Upstream's >272k-context tier fields are
// not kept: the Codex context window is below that, so the base rate always applies.
const isFirstPartyCodex = (id, e) =>
  /^gpt-(5\.[6-9]|[6-9]|\d\d)/.test(id) && e?.litellm_provider === "openai" && ["chat", "responses"].includes(e?.mode);
const wanted = (id, e) =>
  (FAMILY !== "openai" && isFirstPartyClaude(id, e)) || (FAMILY !== "claude" && isFirstPartyCodex(id, e));

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`tokenomics: price fetch failed — HTTP ${res.status} from ${SOURCE}`);
  console.error("tokenomics: the cached prices.json is unchanged and still usable.");
  process.exit(1);
}
const catalog = await res.json();

const prevCached = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { models: {} };
const familyOf = (id) => (id.startsWith("claude-") ? "claude" : "openai");
// A family-limited refresh must leave the other family's cached rows exactly as they are.
const models = FAMILY === "all" ? {} : Object.fromEntries(Object.entries(prevCached.models ?? {}).filter(([id]) => familyOf(id) !== FAMILY));
for (const id of Object.keys(catalog).sort()) {
  const entry = catalog[id];
  if (!wanted(id, entry)) continue;
  if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) continue;
  const kept = {};
  for (const f of COST_FIELDS) if (entry[f] != null) kept[f] = entry[f];
  models[id] = kept;
}
const sortedModels = Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
for (const k of Object.keys(models)) delete models[k];
Object.assign(models, sortedModels);

if (!Object.keys(models).length) {
  console.error("tokenomics: no first-party models matched — upstream schema may have changed.");
  console.error("tokenomics: refusing to overwrite prices.json with an empty table.");
  process.exit(1);
}

const next = {
  _comment:
    "CACHED FROM LITELLM — do not hand-edit. Refresh with `node .octobots/tokenomics/update-prices.mjs` and commit. " +
    "Entries are verbatim upstream: costs are USD PER TOKEN (not per million), under upstream's " +
    "own field names. Refreshing this file re-prices all historical runs on the next rollup.",
  _source: SOURCE,
  // `fetched_at` dates the Claude rows. A Codex-only refresh must not re-date rows it did not touch.
  fetched_at: FAMILY === "openai" ? (prevCached.fetched_at ?? new Date().toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10),
  ...(FAMILY === "claude"
    ? (prevCached.fetched_at_openai ? { fetched_at_openai: prevCached.fetched_at_openai } : {})
    : { fetched_at_openai: new Date().toISOString().slice(0, 10) }),
  models,
};

// Diff against the cached copy — a silent price change is exactly the thing
// that misstates a submission without anyone noticing.
let changed = true;
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, "utf8"));
  const changes = [];
  for (const [id, p] of Object.entries(models)) {
    const old = prev.models?.[id];
    if (!old) { changes.push(`+ ${id} (new)`); continue; }
    for (const f of new Set([...Object.keys(p), ...Object.keys(old)])) {
      if (old[f] !== p[f]) changes.push(`~ ${id}.${f}: ${old[f] ?? "—"} -> ${p[f] ?? "—"}`);
    }
  }
  for (const id of Object.keys(prev.models ?? {})) if (!models[id] && (FAMILY === "all" || familyOf(id) === FAMILY)) changes.push(`- ${id} (gone upstream)`);

  changed = changes.length > 0;
  if (changed) {
    console.error(`tokenomics: ${changes.length} price change(s):`);
    for (const c of changes) console.error(`  ${c}`);
    console.error("tokenomics: re-run `node .octobots/tokenomics/run.mjs` to re-price historical runs.");
  } else {
    console.error("tokenomics: prices unchanged.");
  }
  if (checkOnly) process.exit(changed ? 1 : 0);
}

writeFileSync(OUT, JSON.stringify(next, null, 2) + "\n");
console.error(`tokenomics: wrote ${OUT} (${Object.keys(models).length} models, fetched ${next.fetched_at}, openai ${next.fetched_at_openai ?? "n/a"})`);
