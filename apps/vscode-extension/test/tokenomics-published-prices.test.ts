import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrices } from "@octoshell/tokenomics";

const TOK = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack", "tokenomics");

// Anthropic's published price list, https://platform.claude.com/docs/en/about-claude/pricing
// (read 2026-11-23). USD per million tokens: input, 5m cache write, 1h cache write, cache hit, output.
// Haiku 5.5 is the price for prompts up to 100,000 tokens; the higher price above that is not modelled.
const PUBLISHED: Record<string, [number, number, number, number, number]> = {
  "claude-fable-5-2": [8, 10, 16, 0.2, 40],
  "claude-mythos-5-2": [8, 10, 16, 0.2, 40],
  "claude-fable-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-mythos-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-fable-5": [10, 12.5, 20, 1, 50],
  "claude-mythos-5": [10, 12.5, 20, 1, 50],
  "claude-opus-5-5": [4, 5, 8, 0.2, 20],
  "claude-opus-5": [5, 6.25, 10, 0.5, 25],
  "claude-sonnet-5-5": [2, 2.5, 4, 0.1, 10],
  "claude-sonnet-5": [2, 2.5, 4, 0.2, 10],
  "claude-haiku-5-5": [0.1, 0.125, 0.2, 0.01, 0.5],
};

type Row = Record<string, number | undefined>;
const perMTok = (r: Row) => [
  r.input_cost_per_token,
  r.cache_creation_input_token_cost,
  r.cache_creation_input_token_cost_above_1hr,
  r.cache_read_input_token_cost,
  r.output_cost_per_token,
].map((v) => (v === undefined ? undefined : Math.round(v * 1e6 * 1e6) / 1e6));

const tables: Array<[string, Record<string, Row>]> = [
  ["pack prices.json", JSON.parse(readFileSync(join(TOK, "prices.json"), "utf8")).models],
  ["pack prices.local.json", JSON.parse(readFileSync(join(TOK, "prices.local.json"), "utf8")).models],
  ["extension compiled-in table", loadPrices().models as unknown as Record<string, Row>],
];

describe("Claude 5.x prices match Anthropic's published list", () => {
  for (const [name, models] of tables) {
    it(`${name}: every Claude 5.x row it lists is the published price`, () => {
      for (const [model, row] of Object.entries(models))
        if (model in PUBLISHED) expect([model, ...perMTok(row)]).toEqual([model, ...PUBLISHED[model]!]);
    });
  }

  for (const [name, models] of [tables[0]!, tables[2]!])
    it(`${name}: lists every Claude 5.x model`, () => {
      expect(Object.keys(PUBLISHED).filter((m) => !(m in models))).toEqual([]);
    });
});
