import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const RENDER = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack", "tokenomics", "render.mjs");

const tokens = { input: 0, output: 1_000_000, cache_read: 0, cache_create: 0 };
const row = (over: Record<string, unknown>, octobots: Record<string, unknown>) => ({
  work_item_ref: "x",
  work_item_level: "story",
  work_item_brief: "",
  parent_ref: null,
  maturity: null,
  size_tshirt: "L",
  effort_days: 4,
  complexity_score: null,
  self_size: null,
  story_points: null,
  sessions: 1,
  turns: 10,
  subagent_dispatches: 0,
  orchestrator_cost_pct: 100,
  tokens,
  cost_api_equivalent_usd: 40,
  cost_by_model: { m: 40 },
  cache_read_share_pct: 0,
  net_loc: null, lines_added: null, lines_removed: null, files_changed: null,
  build_cost_usd: null, iterate_cost_usd: null,
  ...over,
  _octobots: { diff_source: null, estimated_retrospectively: false, tasks: [], branches: [], ...octobots },
});

function render(runs: unknown[]): string {
  const dir = mkdtempClean("render-mjs-");
  const tok = join(dir, ".octobots", "tokenomics");
  mkdirSync(tok, { recursive: true });
  writeFileSync(
    join(tok, "runs.json"),
    JSON.stringify({
      factory_id: "f", factory_name: "F", stop: "implementation", owner_group: "dev", default_method: "metered",
      pricing_fetched_at: "2026-10-01", runs,
      unattributed: { segments: 0, turns: 0, branches: [], tokens, cost_api_equivalent_usd: 0 },
    }),
  );
  const r = spawnSync(process.execPath, [RENDER, "--project-dir", dir, "--quiet"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(join(tok, "report.html"), "utf8");
}

const mission = row({ work_item_ref: "demo/M1" }, { mission_id: "M1", mission_name: "Demo mission", campaign: "demo" });
const campaign = row(
  { work_item_ref: "demo", work_item_level: "campaign", size_tshirt: null, effort_days: null, cost_api_equivalent_usd: 5, cost_by_model: { m: 5 } },
  { mission_id: null, mission_name: null, campaign: "demo", campaign_name: "Demo campaign", branches: ["chore/demo-plan"] },
);

describe("render.mjs campaign rows", () => {
  it("counts missions only in the tile, shows campaign work under its own heading, totals include it", () => {
    const html = render([mission, campaign]);
    expect(html).toContain('<div class="v">1</div><div class="k">Missions measured</div>');
    expect(html).toContain('<div class="v">$45.00</div><div class="k">Total metered cost</div>');
    const after = html.slice(html.indexOf("<h2>Campaign-level work</h2>"));
    expect(html).toContain("<h2>Campaign-level work</h2>");
    expect(after.slice(0, after.indexOf("<h2>Per-task breakdown</h2>"))).toContain("chore/demo-plan");
    // The missions table ends where the campaign heading starts, and the campaign is not in it.
    expect(html.slice(0, html.indexOf("<h2>Campaign-level work</h2>"))).not.toContain("Demo campaign");
  });

  it("excludes campaign rows from the no-sizing finding and its denominator", () => {
    const html = render([mission, { ...mission, effort_days: null, _octobots: { ...mission._octobots, mission_id: "M2" } }, campaign]);
    expect(html).toContain("1 of 2 missions have no authored sizing");
  });

  it("omits the section when there are no campaign rows", () => {
    expect(render([mission])).not.toContain("Campaign-level work");
  });
});
