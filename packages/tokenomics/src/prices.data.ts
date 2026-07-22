// GENERATED — do not hand-edit. Refresh with `pnpm --filter @octoshell/tokenomics prices`
// and commit the result; packaging the .vsix refreshes it automatically.
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
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 3e-7,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-3-haiku-20240307": {
    "input_cost_per_token": 2.5e-7,
    "output_cost_per_token": 0.00000125,
    "cache_read_input_token_cost": 3e-8,
    "cache_creation_input_token_cost": 3e-7,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-3-opus-20240229": {
    "input_cost_per_token": 0.000015,
    "output_cost_per_token": 0.000075,
    "cache_read_input_token_cost": 0.0000015,
    "cache_creation_input_token_cost": 0.00001875,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-4-opus-20250514": {
    "input_cost_per_token": 0.000015,
    "output_cost_per_token": 0.000075,
    "cache_read_input_token_cost": 0.0000015,
    "cache_creation_input_token_cost": 0.00001875
  },
  "claude-4-sonnet-20250514": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 3e-7,
    "cache_creation_input_token_cost": 0.00000375
  },
  "claude-fable-5": {
    "input_cost_per_token": 0.00001,
    "output_cost_per_token": 0.00005,
    "cache_read_input_token_cost": 0.000001,
    "cache_creation_input_token_cost": 0.0000125,
    "cache_creation_input_token_cost_above_1hr": 0.00002
  },
  "claude-haiku-4-5": {
    "input_cost_per_token": 0.000001,
    "output_cost_per_token": 0.000005,
    "cache_read_input_token_cost": 1e-7,
    "cache_creation_input_token_cost": 0.00000125,
    "cache_creation_input_token_cost_above_1hr": 0.000002
  },
  "claude-haiku-4-5-20251001": {
    "input_cost_per_token": 0.000001,
    "output_cost_per_token": 0.000005,
    "cache_read_input_token_cost": 1e-7,
    "cache_creation_input_token_cost": 0.00000125,
    "cache_creation_input_token_cost_above_1hr": 0.000002
  },
  "claude-opus-4-1": {
    "input_cost_per_token": 0.000015,
    "output_cost_per_token": 0.000075,
    "cache_read_input_token_cost": 0.0000015,
    "cache_creation_input_token_cost": 0.00001875,
    "cache_creation_input_token_cost_above_1hr": 0.00003
  },
  "claude-opus-4-1-20250805": {
    "input_cost_per_token": 0.000015,
    "output_cost_per_token": 0.000075,
    "cache_read_input_token_cost": 0.0000015,
    "cache_creation_input_token_cost": 0.00001875,
    "cache_creation_input_token_cost_above_1hr": 0.00003
  },
  "claude-opus-4-20250514": {
    "input_cost_per_token": 0.000015,
    "output_cost_per_token": 0.000075,
    "cache_read_input_token_cost": 0.0000015,
    "cache_creation_input_token_cost": 0.00001875,
    "cache_creation_input_token_cost_above_1hr": 0.00003
  },
  "claude-opus-4-5": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-opus-4-5-20251101": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-opus-4-6": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-opus-4-6-20260205": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-opus-4-7": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-opus-4-7-20260416": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-opus-4-8": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 5e-7,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_creation_input_token_cost_above_1hr": 0.00001
  },
  "claude-sonnet-4-20250514": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 3e-7,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-sonnet-4-5": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 3e-7,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-sonnet-4-5-20250929": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 3e-7,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-sonnet-4-6": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 3e-7,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_creation_input_token_cost_above_1hr": 0.000006
  },
  "claude-sonnet-5": {
    "input_cost_per_token": 0.000002,
    "output_cost_per_token": 0.00001,
    "cache_read_input_token_cost": 2e-7,
    "cache_creation_input_token_cost": 0.0000025,
    "cache_creation_input_token_cost_above_1hr": 0.000004
  }
};
