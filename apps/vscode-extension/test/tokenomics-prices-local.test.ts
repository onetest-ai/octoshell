import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrices } from "@octoshell/tokenomics";
import { installTokenomics } from "../src/host/octobots-tokenomics.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack");

// Independent source of truth: solo's prices.json values for the two seeded models.
const OPUS_5_5 = {
  input_cost_per_token: 0.000004,
  output_cost_per_token: 0.00002,
  cache_read_input_token_cost: 0.0000002,
  cache_creation_input_token_cost: 0.000005,
  cache_creation_input_token_cost_above_1hr: 0.000008,
};
const SONNET_5_5 = {
  input_cost_per_token: 0.000002,
  output_cost_per_token: 0.00001,
  cache_read_input_token_cost: 0.0000002,
  cache_creation_input_token_cost: 0.0000025,
  cache_creation_input_token_cost_above_1hr: 0.000004,
};

/** A workspace with the pack's tokenomics CLI installed. */
function workspace(): { repo: string; tok: string } {
  const repo = mkdtempClean("tok-prices-local-");
  installTokenomics(PACK, repo);
  return { repo, tok: join(repo, ".octobots", "tokenomics") };
}

/** Runs update-prices.mjs with `fetch` stubbed: upstream knows opus-4-8 and a DIFFERENT sonnet-5-5 price. */
function refreshPrices(tok: string): void {
  const stub = join(tok, "..", "fetch-stub.mjs");
  const catalog = {
    "claude-opus-4-8": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
    "claude-sonnet-5-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 9e-6, output_cost_per_token: 45e-6 },
  };
  writeFileSync(
    stub,
    `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (${JSON.stringify(catalog)}) });\n`,
  );
  const r = spawnSync(process.execPath, ["--import", stub, join(tok, "update-prices.mjs")], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
}

/** One unattributed segment of 1M input tokens on `model`; returns the rollup's USD total for it. */
function rollupCost(repo: string, model: string): number {
  const tok = join(repo, ".octobots", "tokenomics");
  mkdirSync(join(tok, "raw"), { recursive: true });
  const seg = {
    session_id: "s1", agent: "main", branch: "main", turns: 1,
    started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z",
    tokens_by_model: { [model]: { input_tokens: 1_000_000 } },
  };
  writeFileSync(join(tok, "raw", "segments.jsonl"), JSON.stringify(seg) + "\n");
  const r = spawnSync(
    process.execPath,
    [join(tok, "rollup.mjs"), "--project-dir", repo, "--no-gh", "--quiet"],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  const runs = JSON.parse(readFileSync(join(tok, "runs.json"), "utf8"));
  return runs.unattributed.cost_api_equivalent_usd as number;
}

describe("pack prices.local.json", () => {
  it("ships seeded with claude-opus-5-5 and claude-sonnet-5-5 at solo's values", () => {
    const local = JSON.parse(readFileSync(join(PACK, "tokenomics", "prices.local.json"), "utf8"));
    expect(local.models["claude-opus-5-5"]).toEqual(OPUS_5_5);
    expect(local.models["claude-sonnet-5-5"]).toEqual(SONNET_5_5);
    expect(Object.keys(local.models).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("is installed with the pack", () => {
    const { tok } = workspace();
    expect(existsSync(join(tok, "prices.local.json"))).toBe(true);
  });

  it("keeps both models priced after update-prices.mjs refreshes prices.json, and prices.json wins on conflict", () => {
    const { repo, tok } = workspace();
    const localBefore = readFileSync(join(tok, "prices.local.json"));

    // Before the refresh the bundled prices.json lacks both models: local alone prices them.
    expect(rollupCost(repo, "claude-sonnet-5-5")).toBeCloseTo(2, 6);

    refreshPrices(tok);
    const refreshed = JSON.parse(readFileSync(join(tok, "prices.json"), "utf8"));
    expect(refreshed.models["claude-opus-5-5"]).toBeUndefined(); // the refresh wrote only upstream's models
    expect(readFileSync(join(tok, "prices.local.json")).equals(localBefore)).toBe(true);

    // opus-5-5 is not upstream: priced from prices.local.json (1M input x 4e-6 = $4).
    expect(rollupCost(repo, "claude-opus-5-5")).toBeCloseTo(4, 6);
    // sonnet-5-5 is in both: prices.json (9e-6/token) wins over prices.local.json (2e-6).
    expect(rollupCost(repo, "claude-sonnet-5-5")).toBeCloseTo(9, 6);
  });

  it("is preserved byte-identical when the pack is re-installed over an edited copy", () => {
    const { repo, tok } = workspace();
    const target = join(tok, "prices.local.json");
    writeFileSync(target, JSON.stringify({ models: { "my-model": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } } }, null, 3));
    const edited = readFileSync(target);

    installTokenomics(PACK, repo);

    expect(readFileSync(target).equals(edited)).toBe(true);
  });

  it("agrees with the extension's compiled-in table, which never reads a workspace file", () => {
    const compiled = loadPrices();
    expect(compiled.models["claude-opus-5-5"]).toEqual(OPUS_5_5);
    expect(compiled.models["claude-sonnet-5-5"]).toEqual(SONNET_5_5);
  });
});
