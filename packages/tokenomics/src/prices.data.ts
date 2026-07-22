// GENERATED — do not hand-edit. Refresh with `pnpm --filter @octoshell/tokenomics prices`
// and commit the result.
//
// Cached VERBATIM from LiteLLM's public catalog: same field names, same
// per-token units, so any number here can be diffed straight against upstream.
// A TypeScript module rather than a JSON file on purpose — the extension is
// bundled, so a runtime file read would resolve to a path that does not exist
// in the packaged .vsix.
import type { PriceEntry } from "./prices.js";

export const PRICES_SOURCE =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const PRICES_FETCHED_AT = "2026-07-22";

export const PRICES: Record<string, PriceEntry> = {
  "claude-3-7-sonnet-20250219": {
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-3-haiku-20240307": {
    "input_cost_per_token": 2.5e-07,
    "output_cost_per_token": 1.25e-06,
    "cache_read_input_token_cost": 3e-08,
    "cache_creation_input_token_cost": 3e-07,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-3-opus-20240229": {
    "input_cost_per_token": 1.5e-05,
    "output_cost_per_token": 7.5e-05,
    "cache_read_input_token_cost": 1.5e-06,
    "cache_creation_input_token_cost": 1.875e-05,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-4-opus-20250514": {
    "input_cost_per_token": 1.5e-05,
    "output_cost_per_token": 7.5e-05,
    "cache_read_input_token_cost": 1.5e-06,
    "cache_creation_input_token_cost": 1.875e-05
  },
  "claude-4-sonnet-20250514": {
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06
  },
  "claude-fable-5": {
    "input_cost_per_token": 1e-05,
    "output_cost_per_token": 5e-05,
    "cache_read_input_token_cost": 1e-06,
    "cache_creation_input_token_cost": 1.25e-05,
    "cache_creation_input_token_cost_above_1hr": 2e-05
  },
  "claude-haiku-4-5": {
    "input_cost_per_token": 1e-06,
    "output_cost_per_token": 5e-06,
    "cache_read_input_token_cost": 1e-07,
    "cache_creation_input_token_cost": 1.25e-06,
    "cache_creation_input_token_cost_above_1hr": 2e-06
  },
  "claude-haiku-4-5-20251001": {
    "input_cost_per_token": 1e-06,
    "output_cost_per_token": 5e-06,
    "cache_read_input_token_cost": 1e-07,
    "cache_creation_input_token_cost": 1.25e-06,
    "cache_creation_input_token_cost_above_1hr": 2e-06
  },
  "claude-opus-4-1": {
    "input_cost_per_token": 1.5e-05,
    "output_cost_per_token": 7.5e-05,
    "cache_read_input_token_cost": 1.5e-06,
    "cache_creation_input_token_cost": 1.875e-05,
    "cache_creation_input_token_cost_above_1hr": 3e-05
  },
  "claude-opus-4-1-20250805": {
    "input_cost_per_token": 1.5e-05,
    "output_cost_per_token": 7.5e-05,
    "cache_read_input_token_cost": 1.5e-06,
    "cache_creation_input_token_cost": 1.875e-05,
    "cache_creation_input_token_cost_above_1hr": 3e-05
  },
  "claude-opus-4-20250514": {
    "input_cost_per_token": 1.5e-05,
    "output_cost_per_token": 7.5e-05,
    "cache_read_input_token_cost": 1.5e-06,
    "cache_creation_input_token_cost": 1.875e-05,
    "cache_creation_input_token_cost_above_1hr": 3e-05
  },
  "claude-opus-4-5": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-opus-4-5-20251101": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-opus-4-6": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-opus-4-6-20260205": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-opus-4-7": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-opus-4-7-20260416": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-opus-4-8": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06,
    "cache_creation_input_token_cost_above_1hr": 1e-05
  },
  "claude-sonnet-4-20250514": {
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-sonnet-4-5": {
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-sonnet-4-5-20250929": {
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-sonnet-4-6": {
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06,
    "cache_creation_input_token_cost_above_1hr": 6e-06
  },
  "claude-sonnet-5": {
    "input_cost_per_token": 2e-06,
    "output_cost_per_token": 1e-05,
    "cache_read_input_token_cost": 2e-07,
    "cache_creation_input_token_cost": 2.5e-06,
    "cache_creation_input_token_cost_above_1hr": 4e-06
  }
};
