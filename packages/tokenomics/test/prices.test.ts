import { describe, it, expect } from "vitest";
import { costOfModel, loadPrices, unpricedModels, type PriceTable } from "../src/prices.js";
import { emptyTotals } from "../src/types.js";

const table: PriceTable = {
  models: {
    "claude-opus-4-8": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 25e-6,
      cache_read_input_token_cost: 0.5e-6,
      cache_creation_input_token_cost: 6.25e-6,
      cache_creation_input_token_cost_above_1hr: 10e-6,
    },
    // Upstream sometimes omits cache fields; and some legacy entries report a
    // 1h write CHEAPER than the 5m one, which cannot be right.
    "legacy-model": {
      input_cost_per_token: 10e-6,
      output_cost_per_token: 20e-6,
      cache_creation_input_token_cost: 18e-6,
      cache_creation_input_token_cost_above_1hr: 6e-6,
    },
  },
};

const tokens = (over: Partial<ReturnType<typeof emptyTotals>>) => ({ ...emptyTotals(), ...over });

describe("pricing", () => {
  it("prices each token class at its own rate", () => {
    const cost = costOfModel(table, "claude-opus-4-8", tokens({ input: 1e6, output: 1e6 }));
    expect(cost).toBeCloseTo(5 + 25, 6);
  });

  // The TTL-agnostic total covers the same tokens as the 5m/1h split; pricing
  // both would double-count every cache write.
  it("does not double-count the TTL-agnostic cacheCreate total", () => {
    const cost = costOfModel(
      table,
      "claude-opus-4-8",
      tokens({ cacheCreate: 1e6, cacheCreate5m: 1e6, cacheCreate1h: 0 }),
    );
    expect(cost).toBeCloseTo(6.25, 6);
  });

  it("prices 1h cache writes above 5m ones", () => {
    const fiveM = costOfModel(table, "claude-opus-4-8", tokens({ cacheCreate5m: 1e6 }));
    const oneH = costOfModel(table, "claude-opus-4-8", tokens({ cacheCreate1h: 1e6 }));
    expect(oneH).toBeGreaterThan(fiveM);
  });

  it("never prices a 1h write below the documented 2x, even if upstream says so", () => {
    // Upstream claims 6e-6 for 1h vs 18e-6 for 5m — impossible. Falls back to 2x input.
    const oneH = costOfModel(table, "legacy-model", tokens({ cacheCreate1h: 1e6 }));
    expect(oneH).toBeCloseTo(20, 6);
  });

  it("falls back to the documented multipliers when a cache rate is missing", () => {
    const t: PriceTable = { models: { m: { input_cost_per_token: 10e-6, output_cost_per_token: 20e-6 } } };
    expect(costOfModel(t, "m", tokens({ cacheRead: 1e6 }))).toBeCloseTo(1, 6); // 0.1x
    expect(costOfModel(t, "m", tokens({ cacheCreate5m: 1e6 }))).toBeCloseTo(12.5, 6); // 1.25x
  });

  it("reports an unknown model instead of guessing a price", () => {
    expect(costOfModel(table, "who-knows", tokens({ output: 1e9 }))).toBe(0);
    expect(unpricedModels(table, ["claude-opus-4-8", "who-knows"])).toEqual(["who-knows"]);
  });

  it("tolerates variant suffixes on a model id", () => {
    expect(costOfModel(table, "claude-opus-4-8[1m]", tokens({ input: 1e6 }))).toBeCloseTo(5, 6);
  });

  it("ships a cached table with the current models", () => {
    const cached = loadPrices();
    expect(Object.keys(cached.models).length).toBeGreaterThan(5);
    expect(cached.models["claude-opus-4-8"]?.input_cost_per_token).toBeGreaterThan(0);
  });
});
