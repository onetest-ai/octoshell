import { readFileSync } from "node:fs";
import { PRICES, PRICES_FETCHED_AT, PRICES_SOURCE } from "./prices.data.js";
import type { TokenTotals } from "./types.js";

/**
 * Cached price table, copied VERBATIM from LiteLLM's public catalog — same field
 * names, same per-token units. There is no local price schema to drift, and any
 * number here can be diffed straight against upstream.
 *
 * Deliberately a cached file, never a fetch: collection stays offline and
 * deterministic, so a run from six months ago re-prices identically unless
 * someone refreshes the table on purpose. Because cost is always recomputed
 * from raw tokens, refreshing re-prices all history.
 */
export interface PriceEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

export interface PriceTable {
  _source?: string;
  fetched_at?: string;
  models: Record<string, PriceEntry>;
}

/**
 * The cached table. Pass `path` only to price against a different snapshot (a
 * historical table, or a fixture) — the default is compiled in, so it works
 * identically in the bundled extension and under test.
 */
export function loadPrices(path?: string): PriceTable {
  if (path) return JSON.parse(readFileSync(path, "utf8")) as PriceTable;
  return { _source: PRICES_SOURCE, fetched_at: PRICES_FETCHED_AT ?? undefined, models: PRICES };
}

/** Look up a model, tolerating variant suffixes (`…[1m]`) and dated ids. */
export function priceOf(table: PriceTable, model: string): PriceEntry | null {
  const base = model.replace(/\[.*$/, "");
  return table.models[base] ?? table.models[base.replace(/-\d{8}$/, "")] ?? null;
}

/**
 * Rate for one cost field, with the documented multipliers as fallback when
 * upstream omits it: cache reads bill at 0.1x input, 5-minute writes at 1.25x,
 * 1-hour writes at 2x.
 */
function rate(entry: PriceEntry, field: keyof PriceEntry): number {
  const input = entry.input_cost_per_token ?? 0;
  const value = entry[field];

  // A longer-lived cache write can never be CHEAPER than a shorter-lived one,
  // yet some legacy upstream entries say exactly that. Reject the impossible
  // value rather than importing it — a missing rate and a wrong rate both fall
  // back to the documented 2x. (The 2x/1.25x/0.1x multipliers are the published
  // relationships to the input rate.)
  if (field === "cache_creation_input_token_cost_above_1hr") {
    const fiveM = entry.cache_creation_input_token_cost ?? input * 1.25;
    return value != null && value >= fiveM ? value : input * 2;
  }

  if (value != null) return value;
  switch (field) {
    case "cache_read_input_token_cost":
      return input * 0.1;
    case "cache_creation_input_token_cost":
      return input * 1.25;
    default:
      return 0;
  }
}

/**
 * Cost of one model's tokens.
 *
 * `cacheCreate` (the TTL-agnostic total) is deliberately NOT priced: the 5m/1h
 * split covers the same tokens at their real rates, so pricing both would
 * double-count every cache write.
 */
export function costOfModel(table: PriceTable, model: string, t: TokenTotals): number {
  const e = priceOf(table, model);
  if (!e) return 0; // unpriced models are reported, not guessed at
  return (
    t.input * rate(e, "input_cost_per_token") +
    t.output * rate(e, "output_cost_per_token") +
    t.cacheRead * rate(e, "cache_read_input_token_cost") +
    t.cacheCreate5m * rate(e, "cache_creation_input_token_cost") +
    t.cacheCreate1h * rate(e, "cache_creation_input_token_cost_above_1hr")
  );
}

export function costOf(table: PriceTable, byModel: Record<string, TokenTotals>): number {
  let usd = 0;
  for (const [model, t] of Object.entries(byModel)) usd += costOfModel(table, model, t);
  return usd;
}

/** Cache-read share of COST (distinct from, and lower than, its token share). */
export function cacheReadCost(table: PriceTable, byModel: Record<string, TokenTotals>): number {
  let usd = 0;
  for (const [model, t] of Object.entries(byModel)) {
    const e = priceOf(table, model);
    if (e) usd += t.cacheRead * rate(e, "cache_read_input_token_cost");
  }
  return usd;
}

/** Models present in the data but absent from the table — their cost reads 0. */
export function unpricedModels(table: PriceTable, models: Iterable<string>): string[] {
  const missing = new Set<string>();
  for (const m of models) if (!priceOf(table, m)) missing.add(m);
  return [...missing].sort();
}
