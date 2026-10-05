import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  // Locally-seeded models (the pack's prices.local.json, merged under upstream by
  // scripts/update-prices.mjs) must be priced by the compiled-in table.
  it("prices the locally-seeded claude-opus-5-5 and claude-sonnet-5-5 from the compiled-in table", () => {
    const cached = loadPrices();
    expect(cached.models["claude-opus-5-5"]).toEqual({
      input_cost_per_token: 0.000004,
      output_cost_per_token: 0.00002,
      cache_read_input_token_cost: 0.0000002,
      cache_creation_input_token_cost: 0.000005,
      cache_creation_input_token_cost_above_1hr: 0.000008,
    });
    expect(cached.models["claude-sonnet-5-5"]?.input_cost_per_token).toBe(0.000002);
    expect(costOfModel(cached, "claude-opus-5-5", tokens({ input: 1e6, output: 1e6 }))).toBeCloseTo(4 + 20, 6);
    expect(unpricedModels(cached, ["claude-opus-5-5", "claude-sonnet-5-5"])).toEqual([]);
  });
});

// scripts/update-prices.mjs, run for real with `fetch` stubbed and its output + seed redirected to a
// temp dir (OCTOSHELL_PRICES_OUT / OCTOSHELL_PRICES_LOCAL), so the repo's prices.data.ts is never touched.
describe("update-prices.mjs seed merge", () => {
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "update-prices.mjs");
  // Independent literals: upstream lists sonnet-x at 9e-6 and knows nothing of local-only.
  const CATALOG = {
    "claude-sonnet-x": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 9e-6, output_cost_per_token: 45e-6 },
  };

  function run(seed: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "update-prices-"));
    const stub = join(dir, "fetch-stub.mjs");
    writeFileSync(stub, `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (${JSON.stringify(CATALOG)}) });\n`);
    const seedFile = join(dir, "prices.local.json");
    if (seed !== null) writeFileSync(seedFile, seed);
    const out = join(dir, "prices.data.ts");
    const r = spawnSync(process.execPath, ["--import", stub, SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, OCTOSHELL_PRICES_OUT: out, OCTOSHELL_PRICES_LOCAL: seedFile },
    });
    return { r, seedFile, data: (() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })() };
  }

  it("upstream wins when the seed lists the same model, and seed-only models are kept", () => {
    const seed = JSON.stringify({ models: {
      "claude-sonnet-x": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      "local-only": { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 },
    } });
    const { r, data } = run(seed);
    expect(r.status, r.stderr).toBe(0);
    expect(data).toContain('"input_cost_per_token": 0.000009'); // upstream's sonnet-x, not the seed's 1e-6
    expect(data).not.toContain('"input_cost_per_token": 0.000001');
    expect(data).toContain('"local-only"');
  });

  it("a malformed seed is reported on stderr, naming the file and the parse error, and the refresh still succeeds", () => {
    const { r, seedFile, data } = run("{");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(seedFile);
    expect(r.stderr).toMatch(/JSON|Unexpected|Expected/i);
    expect(data).toContain('"claude-sonnet-x"'); // upstream still written
  });

  it("a missing seed is not an error and prints no seed warning", () => {
    const { r, seedFile } = run(null);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain(seedFile);
  });
});
