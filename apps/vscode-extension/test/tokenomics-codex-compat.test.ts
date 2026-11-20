import { BoardModel } from "@octoshell/board";
import { rollup, emptyTotals } from "@octoshell/tokenomics";
import { it, expect } from "vitest";
import { mkdirSync, chmodSync, existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const pack = join(__dirname, "../resources/octobots-pack");
it("preserves a consumer's Codex source fields and Claude-only counters without changing total tokens or pricing", () => {
  const dir = mkdtempClean("codex-output-compat-");
  const write = (path: string, data: string) => { const f = join(dir, path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };
  write(".octobots/campaigns/demo/campaign.yaml", "name: Demo\nstatus: draft\n");
  write(".octobots/campaigns/demo/missions/m1-work/mission.yaml", "name: M1 - Work\nstatus: draft\n");
  const vendor = ".claude/skills/mission-planner/scripts/vendor/js-yaml.mjs";
  write(vendor, ""); copyFileSync(join(pack, "skill/mission-planner/scripts/vendor/js-yaml.mjs"), join(dir, vendor));
  write(".octobots/tokenomics/prices.json", JSON.stringify({ models: { cheap: { input_cost_per_token: 0.000001 } } }));
  write(".octobots/tokenomics/raw/segments.jsonl", [undefined, "codex"].map((source, i) => JSON.stringify({
    segment_id: `seg-${i}`, session_id: `session-${i}`, branch: "feat/demo-m1-t1", kind: "orchestrator", source,
    started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z", turns: i + 2,
    tokens_by_model: { cheap: { input_tokens: 1000000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })).join("\n"));
  // A resolvable branch reaches the PR-base fallback. --no-gh must still remain offline.
  write("bin/git", '#!/usr/bin/env node\nconsole.log("abc");\n');
  write("bin/gh", '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.GH_CALLED_FILE, "called");\nconsole.log("[]");\n');
  chmodSync(join(dir, "bin/git"), 0o755); chmodSync(join(dir, "bin/gh"), 0o755);
  const marker = join(dir, "gh-called");
  const result = spawnSync("node", [join(pack, "tokenomics/rollup.mjs"), "--project-dir", dir, "--no-gh", "--quiet"], { encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_CALLED_FILE: marker } });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(readFileSync(join(dir, ".octobots/tokenomics/runs.json"), "utf8"));
  expect(report.runs[0]).toMatchObject({ sessions: 1, turns: 2, cost_api_equivalent_usd: 2,
    tokens: { input: 2000000 }, cost_by_source: { claude: 1, codex: 1 },
    codex: { segments: 1, sessions: 1, turns: 3, cost_api_equivalent_usd: 1, attribution: { branch: 1, ledger_window: 0 } },
    _octobots: { tasks: [{ sessions: 1, turns: 2, cost_api_equivalent_usd: 2, cost_by_source: { claude: 1, codex: 1 } }] },
  });
  const board = new BoardModel(join(dir, ".octobots")); board.rebuild();
  const ts = rollup({ repoRoot: dir, artifactsRoot: join(dir, ".octobots"), board,
    prices: { models: { cheap: { input_cost_per_token: 0.000001 } } },
    source: { agentTool: "mixed", collect: () => [undefined, "codex"].map((source, i) => ({
      segmentId: `seg-${i}`, sessionId: `session-${i}`, kind: "orchestrator", source,
      agentType: null, workflowId: null, branch: "feat/demo-m1-t1", turns: i + 2,
      startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z",
      tokensByModel: { cheap: { ...emptyTotals(), input: 1000000 } }, tools: {},
    })) },
  });
  expect(ts.runs[0]).toMatchObject({ sessions: 1, turns: 2, costUsd: 2, tasks: [{ turns: 2, costUsd: 2 }] });
  expect(existsSync(marker), "--no-gh must never invoke gh").toBe(false);
  expect(report.by_source).toMatchObject({ claude: { segments: 1, cost_api_equivalent_usd: 1 }, codex: { segments: 1, cost_api_equivalent_usd: 1 } });
});
