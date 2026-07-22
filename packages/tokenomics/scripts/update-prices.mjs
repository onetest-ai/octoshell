// Regenerate the cached price table from LiteLLM's public catalog.
//
//   pnpm --filter @octoshell/tokenomics prices          # refresh + report drift
//   pnpm --filter @octoshell/tokenomics prices --check  # report drift, write nothing
//
// Runs as part of packaging the .vsix, so every release ships current prices
// without anyone remembering to refresh them. NEVER fetched at runtime: the
// table is compiled in, so collection stays offline and deterministic and a
// report from six months ago re-prices identically unless someone deliberately
// rebuilds. Because cost is always recomputed from raw tokens, refreshing the
// table re-prices all history.
//
// A network failure is NOT an error. Packaging must not break because GitHub is
// unreachable — the cached table is still valid, just older, so we warn and
// exit 0.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "prices.data.ts");
const checkOnly = process.argv.includes("--check");

/** The cost fields we keep, under upstream's own names. */
const COST_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
];

// First-party Anthropic ids only — the strings that actually appear as
// `message.model` in a transcript. Regional (`us.`/`eu.`/…) and provider-prefixed
// (`anthropic.`, `vertex_ai/`) variants price differently and would silently
// shadow the first-party rate.
const isFirstPartyClaude = (id, e) =>
  /^claude-/.test(id) && e?.litellm_provider === "anthropic" && e?.mode === "chat";

function currentModels() {
  try {
    const text = readFileSync(OUT, "utf8");
    const json = text.slice(text.indexOf("= {", text.indexOf("PRICES")) + 2).replace(/;\s*$/, "");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

let catalog;
try {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  catalog = await res.json();
} catch (err) {
  console.warn(`[tokenomics] price refresh skipped — ${err.message}`);
  console.warn("[tokenomics] the cached table is unchanged and still usable.");
  process.exit(0); // never break a build over this
}

const models = {};
for (const id of Object.keys(catalog).sort()) {
  const entry = catalog[id];
  if (!isFirstPartyClaude(id, entry)) continue;
  if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) continue;
  const kept = {};
  for (const f of COST_FIELDS) if (entry[f] != null) kept[f] = entry[f];
  models[id] = kept;
}

if (Object.keys(models).length === 0) {
  console.warn("[tokenomics] no first-party Claude models matched — upstream schema may have changed.");
  console.warn("[tokenomics] refusing to overwrite the table with an empty one.");
  process.exit(0);
}

// Report what moved: a silent price change is exactly what misstates a cost
// report without anyone noticing.
const prev = currentModels();
const changes = [];
for (const [id, p] of Object.entries(models)) {
  const old = prev[id];
  if (!old) { changes.push(`+ ${id}`); continue; }
  for (const f of new Set([...Object.keys(p), ...Object.keys(old)])) {
    if (old[f] !== p[f]) changes.push(`~ ${id}.${f}: ${old[f] ?? "—"} -> ${p[f] ?? "—"}`);
  }
}
for (const id of Object.keys(prev)) if (!models[id]) changes.push(`- ${id} (gone upstream)`);

if (changes.length) {
  console.warn(`[tokenomics] ${changes.length} price change(s):`);
  for (const c of changes) console.warn(`  ${c}`);
} else {
  console.warn("[tokenomics] prices unchanged.");
}
if (checkOnly) process.exit(changes.length ? 1 : 0);

const fetchedAt = new Date().toISOString().slice(0, 10);
writeFileSync(
  OUT,
  `// GENERATED — do not hand-edit. Refresh with \`pnpm --filter @octoshell/tokenomics prices\`
// and commit the result; packaging the .vsix refreshes it automatically.
//
// Cached VERBATIM from LiteLLM's public catalog: same field names, same
// per-token units, so any number here can be diffed straight against upstream.
// A TypeScript module rather than a JSON file on purpose — the extension is
// bundled, so a runtime file read would resolve to a path that does not exist
// in the packaged .vsix.
import type { PriceEntry } from "./prices.js";

export const PRICES_SOURCE =
  ${JSON.stringify(SOURCE)};
export const PRICES_FETCHED_AT = ${JSON.stringify(fetchedAt)};

export const PRICES: Record<string, PriceEntry> = ${JSON.stringify(models, null, 2)};
`,
);
console.warn(`[tokenomics] wrote ${OUT} (${Object.keys(models).length} models, fetched ${fetchedAt})`);
