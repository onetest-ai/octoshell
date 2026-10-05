/**
 * Mission AC5: the pack CLI (rollup.mjs) and the extension (rollup.ts) are two implementations of one
 * attribution contract. This table drives BOTH over the same segments and board and demands the same
 * answer, step by step, for the 7-step precedence:
 *
 *   1 a mission declares the branch   2 campaign slug in the branch (+ `-m<n>`)   3 slug, single mission
 *   4 worklog `session|branch` -> a task id unique to one mission   5 a campaign declares the branch
 *   6 campaign slug in the branch -> campaign row   7 unattributed
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dump } from "js-yaml";
import { BoardModel } from "@octoshell/board";
import { rollup } from "../src/rollup.js";
import { isCampaignRun, type MissionRun } from "../src/types.js";
import type { PriceTable } from "../src/prices.js";
import { jsonlSource } from "./helpers/jsonl-source.js";
import table from "./fixtures/attribution-cases.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "../../../apps/vscode-extension/resources/octobots-pack");
const ROLLUP = join(PACK, "tokenomics/rollup.mjs");
const PACK_YAML = join(PACK, "skill/mission-planner/scripts/vendor/js-yaml.mjs");

interface AuthoredBranches { branches: string[] | string }
interface FixtureMission { dir: string; name: string; tokenomics?: AuthoredBranches; tasks: string[] }
interface FixtureCampaign { slug: string; name: string; tokenomics?: AuthoredBranches; missions: FixtureMission[] }
interface Case { id: string; step: number; branch: string; session: string; expect: string }
const fixture = table as unknown as {
  board: { campaigns: FixtureCampaign[] };
  worklog: Array<Record<string, unknown>>;
  cases: Case[];
};

const PRICES: PriceTable = {
  _source: "test",
  fetched_at: "2026-10-01",
  models: {
    cheap: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7 },
  },
};

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tok-parity-attr-"));
  tmpDirs.push(d);
  return d;
};

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};

/** Write the fixture as a real project: board YAML, worklog, segments, prices, and a pack YAML parser. */
function materialise(): string {
  const dir = mkTmp();
  const oct = join(dir, ".octobots");
  for (const c of fixture.board.campaigns) {
    const cdir = join(oct, "campaigns", c.slug);
    write(
      join(cdir, "campaign.yaml"),
      dump({
        name: c.name,
        status: "draft",
        description: `${c.name} description`,
        acceptance_criteria: [],
        ...(c.tokenomics ? { tokenomics: c.tokenomics } : {}),
      }),
    );
    for (const m of c.missions) {
      const mdir = join(cdir, "missions", m.dir);
      write(
        join(mdir, "mission.yaml"),
        dump({
          name: m.name,
          status: "draft",
          description: `${m.name} description`,
          acceptance_criteria: [{ text: "ac", done: false }],
          ...(m.tokenomics ? { tokenomics: m.tokenomics } : {}),
        }),
      );
      for (const t of m.tasks) {
        const id = /^T(\d+)\.(\d+)/.exec(t)!;
        write(
          join(mdir, "tasks", `t${id[1]}-${id[2]}-x`, "task.yaml"),
          dump({ name: t, status: "draft", role: "js-dev", description: "d", acceptance_criteria: [{ text: "ac", done: false }] }),
        );
      }
    }
  }
  const tok = join(oct, "tokenomics");
  write(join(tok, "worklog.jsonl"), fixture.worklog.map((e) => JSON.stringify(e)).join("\n") + "\n");
  write(join(tok, "prices.json"), JSON.stringify(PRICES));
  const segs = fixture.cases.map((c, i) => {
    const n = i + 1;
    return {
      segment_id: `${c.session}:main:${c.branch}`,
      session_id: c.session,
      kind: "orchestrator",
      agent_type: null,
      branch: c.branch,
      started_at: `2026-10-01T00:00:${String(n).padStart(2, "0")}.000Z`,
      ended_at: `2026-10-01T00:01:${String(n).padStart(2, "0")}.000Z`,
      turns: n,
      tokens_by_model: {
        cheap: {
          input_tokens: n * 1_000_000,
          output_tokens: n * 100_000,
          cache_read_input_tokens: n * 10,
          cache_creation_input_tokens: 0,
          cache_creation_5m_tokens: 0,
          cache_creation_1h_tokens: 0,
        },
      },
      tools: {},
    };
  });
  write(join(tok, "raw/segments.jsonl"), segs.map((s) => JSON.stringify(s)).join("\n") + "\n");
  installPackYaml(dir);
  return dir;
}

/** rollup.mjs finds its YAML parser at <project>/.claude/skills/mission-planner/scripts/vendor/. */
function installPackYaml(dir: string): void {
  const dest = join(dir, ".claude/skills/mission-planner/scripts/vendor/js-yaml.mjs");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(PACK_YAML, dest);
}

interface Totals { input: number; output: number; cacheRead: number; cacheCreate: number }
interface NRow { target: string; branches: string[]; sessions: number; turns: number; tokens: Totals; costUsd: number }
interface Normalised {
  rows: NRow[];
  unattributed: { segments: number; turns: number; branches: string[]; tokens: Totals; costUsd: number };
  branchToTarget: Map<string, string>;
}

interface MjsTokens { input: number; output: number; cache_read: number; cache_create: number }
interface MjsRow {
  work_item_level: string;
  tokens: MjsTokens;
  cost_api_equivalent_usd: number;
  sessions: number;
  turns: number;
  _octobots: { campaign: string; mission_id: string | null; branches: string[] };
}
const mjsTotals = (t: MjsTokens): Totals => ({ input: t.input, output: t.output, cacheRead: t.cache_read, cacheCreate: t.cache_create });

function finish(rows: NRow[], unattributed: Normalised["unattributed"]): Normalised {
  rows.sort((a, b) => a.target.localeCompare(b.target));
  const branchToTarget = new Map<string, string>();
  for (const r of rows) for (const b of r.branches) branchToTarget.set(b, r.target);
  for (const b of unattributed.branches) branchToTarget.set(b, "unattributed");
  return { rows, unattributed, branchToTarget };
}

function runMjs(dir: string): Normalised {
  execFileSync("node", [ROLLUP, "--project-dir", dir, "--no-gh", "--quiet"], { encoding: "utf8" });
  const out = JSON.parse(readFileSync(join(dir, ".octobots/tokenomics/runs.json"), "utf8")) as {
    runs: MjsRow[];
    unattributed: { segments: number; turns: number; branches: string[]; tokens: MjsTokens; cost_api_equivalent_usd: number };
  };
  const rows = out.runs.map((r): NRow => ({
    target:
      r.work_item_level === "campaign"
        ? `campaign:${r._octobots.campaign}`
        : `mission:${r._octobots.campaign}/${r._octobots.mission_id}`,
    branches: [...r._octobots.branches].sort(),
    sessions: r.sessions,
    turns: r.turns,
    tokens: mjsTotals(r.tokens),
    costUsd: r.cost_api_equivalent_usd,
  }));
  const u = out.unattributed;
  return finish(rows, {
    segments: u.segments,
    turns: u.turns,
    branches: u.branches,
    tokens: mjsTotals(u.tokens),
    costUsd: u.cost_api_equivalent_usd,
  });
}

const slugOfCampaignId = (id: string): string => id.split("/").filter(Boolean).pop() ?? "";

function runTs(dir: string, prices: PriceTable): Normalised {
  const artifactsRoot = join(dir, ".octobots");
  const board = new BoardModel(artifactsRoot);
  board.rebuild();
  const report = rollup({
    repoRoot: dir,
    artifactsRoot,
    board,
    source: jsonlSource(join(artifactsRoot, "tokenomics/raw/segments.jsonl")),
    prices,
    now: () => new Date(0),
  });
  const tot = (t: MissionRun["tokens"]): Totals => ({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreate: t.cacheCreate });
  const rows = report.runs.map((r): NRow => ({
    target: isCampaignRun(r)
      ? `campaign:${slugOfCampaignId(r.campaignId)}`
      : `mission:${slugOfCampaignId(r.campaignId)}/${/^M\d+/i.exec(r.missionTitle)?.[0]}`,
    branches: [...r.branches].sort(),
    sessions: r.sessions,
    turns: r.turns,
    tokens: tot(r.tokens),
    costUsd: r.costUsd,
  }));
  const u = report.unattributed;
  return finish(rows, { segments: u.segments, turns: u.turns, branches: u.branches, tokens: tot(u.tokens), costUsd: u.costUsd });
}

/** The same merged price table rollup.mjs builds: `prices.local.json` under `prices.json`. */
function pricesOf(dir: string): PriceTable {
  const tok = join(dir, ".octobots/tokenomics");
  const base = JSON.parse(readFileSync(join(tok, "prices.json"), "utf8")) as PriceTable;
  const localFile = join(tok, "prices.local.json");
  if (!existsSync(localFile)) return base;
  const local = JSON.parse(readFileSync(localFile, "utf8")) as PriceTable;
  return { ...base, models: { ...(local.models ?? {}), ...base.models } };
}

function segmentTotals(dir: string): Totals {
  const sum: Totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const lines = readFileSync(join(dir, ".octobots/tokenomics/raw/segments.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  for (const l of lines) {
    const s = JSON.parse(l) as { tokens_by_model: Record<string, Record<string, number>> };
    for (const t of Object.values(s.tokens_by_model)) {
      sum.input += t.input_tokens ?? 0;
      sum.output += t.output_tokens ?? 0;
      sum.cacheRead += t.cache_read_input_tokens ?? 0;
      sum.cacheCreate += t.cache_creation_input_tokens ?? 0;
    }
  }
  return sum;
}

function invariant(n: Normalised, dir: string): void {
  const all: Totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const t of [...n.rows.map((r) => r.tokens), n.unattributed.tokens]) {
    all.input += t.input;
    all.output += t.output;
    all.cacheRead += t.cacheRead;
    all.cacheCreate += t.cacheCreate;
  }
  expect(all).toEqual(segmentTotals(dir));
}

describe("attribution parity: rollup.mjs and rollup.ts", () => {
  const dir = materialise();
  const mjs = runMjs(dir);
  const ts = runTs(dir, pricesOf(dir));

  it.each(fixture.cases)("step $step - $id", (c) => {
    expect(mjs.branchToTarget.get(c.branch), "rollup.mjs").toBe(c.expect);
    expect(ts.branchToTarget.get(c.branch), "rollup.ts").toBe(c.expect);
  });

  it("exercises every one of the 7 precedence steps", () => {
    expect([...new Set(fixture.cases.map((c) => c.step))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("runs[] and unattributed are identical, campaign rows included", () => {
    expect(ts.rows.some((r) => r.target.startsWith("campaign:"))).toBe(true);
    expect(ts).toEqual(mjs);
  });

  it("totals invariant (mjs): sum(runs) + unattributed == segments", () => invariant(mjs, dir));
  it("totals invariant (ts): sum(runs) + unattributed == segments", () => invariant(ts, dir));

  it("cost invariant: attributed + unattributed within per-row rounding of the segments' price", () => {
    const priced = (n: Normalised): number => n.rows.reduce((a, r) => a + r.costUsd, 0) + n.unattributed.costUsd;
    const exact = segmentCost(dir);
    for (const n of [mjs, ts]) expect(Math.abs(priced(n) - exact)).toBeLessThanOrEqual(0.01 * (n.rows.length + 1));
  });
});

function segmentCost(dir: string): number {
  const t = segmentTotals(dir);
  const m = PRICES.models.cheap!;
  return t.input * m.input_cost_per_token! + t.output * m.output_cost_per_token! + t.cacheRead * m.cache_read_input_token_cost!;
}

/**
 * rollup.mjs keys a mission row by `<campaign>/<id>` where the id is the title's `M<n>` token, so a
 * campaign with missions titled `M2a` and `M2b` (both `M2`) gets ONE row; rollup.ts keeps one row per
 * mission folder. Real boards do this (solo's epic-005), so a real copy is compared per shared id.
 */
function mergeSharedIds(rows: NRow[]): Array<NRow & { rows: number }> {
  const out = new Map<string, NRow & { rows: number }>();
  for (const r of rows) {
    const cur = out.get(r.target);
    if (!cur) {
      out.set(r.target, { ...r, tokens: { ...r.tokens }, rows: 1 });
      continue;
    }
    cur.rows += 1;
    cur.branches = [...new Set([...cur.branches, ...r.branches])].sort();
    cur.turns += r.turns;
    cur.sessions += r.sessions;
    cur.costUsd += r.costUsd;
    for (const k of ["input", "output", "cacheRead", "cacheCreate"] as const) cur.tokens[k] += r.tokens[k];
  }
  return [...out.values()];
}

// Environmental: needs a real project's data, which the repo does not carry.
describe.skipIf(!process.env.OCTOBOTS_TOKENOMICS_COPY)("real copy (OCTOBOTS_TOKENOMICS_COPY)", () => {
  it("rollup.mjs and rollup.ts agree on a copy of a real .octobots, and the totals invariant holds", () => {
    const dir = mkTmp();
    cpSync(process.env.OCTOBOTS_TOKENOMICS_COPY!, join(dir, ".octobots"), { recursive: true });
    if (!existsSync(join(dir, ".octobots/tokenomics/prices.json"))) {
      cpSync(join(PACK, "tokenomics/prices.json"), join(dir, ".octobots/tokenomics/prices.json"));
    }
    if (!existsSync(join(dir, ".octobots/tokenomics/prices.local.json")) && existsSync(join(PACK, "tokenomics/prices.local.json"))) {
      cpSync(join(PACK, "tokenomics/prices.local.json"), join(dir, ".octobots/tokenomics/prices.local.json"));
    }
    installPackYaml(dir);
    const mjs = runMjs(dir);
    const ts = runTs(dir, pricesOf(dir));
    invariant(mjs, dir);
    invariant(ts, dir);
    expect(ts.unattributed).toEqual(mjs.unattributed);
    expect(ts.branchToTarget).toEqual(mjs.branchToTarget);
    const merged = mergeSharedIds(ts.rows);
    expect(merged.map((r) => r.target)).toEqual(mjs.rows.map((r) => r.target));
    merged.forEach((t, i) => {
      const m = mjs.rows[i]!;
      expect(t.branches, t.target).toEqual(m.branches);
      expect(t.turns, t.target).toBe(m.turns);
      expect(t.tokens, t.target).toEqual(m.tokens);
      expect(Math.abs(t.costUsd - m.costUsd), t.target).toBeLessThanOrEqual(0.01 * t.rows);
      if (t.rows === 1) expect(t.sessions, t.target).toBe(m.sessions); // sessions are not summable across rows
    });
  });
});
