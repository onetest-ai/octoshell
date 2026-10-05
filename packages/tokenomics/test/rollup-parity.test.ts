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
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dump } from "js-yaml";
import { BoardModel } from "@octoshell/board";
import { rollup } from "../src/rollup.js";
import { readEstimate } from "../src/estimates.js";
import { isCampaignRun, type MissionRun } from "../src/types.js";
import type { PriceTable } from "../src/prices.js";
import { jsonlSource } from "./helpers/jsonl-source.js";
import table from "./fixtures/attribution-cases.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "../../../apps/vscode-extension/resources/octobots-pack");
const ROLLUP = join(PACK, "tokenomics/rollup.mjs");
const PACK_YAML = join(PACK, "skill/mission-planner/scripts/vendor/js-yaml.mjs");

interface AuthoredBranches { branches: string[] | string }
/** A task is its title (folder `t<m>-<n>-x` derived from a `T<m>.<n>` prefix), or an explicit folder + title. */
type FixtureTask = string | { dir: string; name: string };
interface FixtureMission { dir: string; name: string; tokenomics?: AuthoredBranches; tasks: FixtureTask[] }
/**
 * `file` picks how the campaign is written: `yaml` (default), `md` (a legacy `campaign.md` whose
 * `## Tokenomics` block carries `branches:`), or `none` (a bare directory - not a campaign).
 */
interface FixtureCampaign {
  slug: string;
  name: string;
  file?: "yaml" | "md" | "none";
  tokenomics?: AuthoredBranches;
  missions: FixtureMission[];
}
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
    // A second model so per-model cost (costByModel / cost_by_model) is a real split, not a copy of the total.
    dear: { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 5e-7 },
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
    const file = c.file ?? "yaml";
    if (file === "yaml") {
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
    } else if (file === "md") {
      const b = c.tokenomics?.branches;
      const branches = Array.isArray(b) ? b.join(", ") : (b ?? "");
      write(join(cdir, "campaign.md"), `# ${c.name}\n\n## Description\n\n${c.name} description\n\n## Tokenomics\nbranches: ${branches}\n`);
    } else {
      mkdirSync(cdir, { recursive: true });
    }
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
        const [tdir, tname] = typeof t === "string" ? [taskDirOf(t), t] : [t.dir, t.name];
        write(
          join(mdir, "tasks", tdir, "task.yaml"),
          dump({ name: tname, status: "draft", role: "js-dev", description: "d", acceptance_criteria: [{ text: "ac", done: false }] }),
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
        dear: {
          input_tokens: n * 200_000,
          output_tokens: n * 30_000,
          cache_read_input_tokens: n * 5,
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

function taskDirOf(title: string): string {
  const id = /^T(\d+)\.(\d+)/.exec(title)!;
  return `t${id[1]}-${id[2]}-x`;
}

/** rollup.mjs finds its YAML parser at <project>/.claude/skills/mission-planner/scripts/vendor/. */
function installPackYaml(dir: string): void {
  const dest = join(dir, ".claude/skills/mission-planner/scripts/vendor/js-yaml.mjs");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(PACK_YAML, dest);
}

interface Totals { input: number; output: number; cacheRead: number; cacheCreate: number }
interface NRow { target: string; branches: string[]; sessions: number; turns: number; tokens: Totals; costByModel: Record<string, number>; costUsd: number }
interface Normalised {
  rows: NRow[];
  unattributed: { segments: number; turns: number; branches: string[]; tokens: Totals; costByModel: Record<string, number>; costUsd: number };
  branchToTarget: Map<string, string>;
}

interface MjsTokens { input: number; output: number; cache_read: number; cache_create: number }
interface MjsRow {
  work_item_level: string;
  tokens: MjsTokens;
  cost_by_model: Record<string, number>;
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
    unattributed: { segments: number; turns: number; branches: string[]; tokens: MjsTokens; cost_by_model: Record<string, number>; cost_api_equivalent_usd: number };
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
    costByModel: r.cost_by_model,
    costUsd: r.cost_api_equivalent_usd,
  }));
  const u = out.unattributed;
  return finish(rows, {
    segments: u.segments,
    turns: u.turns,
    branches: u.branches,
    tokens: mjsTotals(u.tokens),
    costByModel: u.cost_by_model,
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
  // The mission's board id as rollup.mjs reports it: the title's `M<n> -` prefix, else the folder's `m<n>`.
  const folderOf = new Map(board.listCampaigns().flatMap((c) => board.listMissions(c.id)).map((m) => [m.id, m.folderPath]));
  const missionLabel = (r: MissionRun): string | undefined =>
    /^\s*(M\d+)\s*[-–—:]/.exec(r.missionTitle)?.[1] ??
    /^m(\d+)/i.exec(folderOf.get(r.missionId ?? "")?.split("/").pop() ?? "")?.[1]?.replace(/^/, "M");
  const rows = report.runs.map((r): NRow => ({
    target: isCampaignRun(r)
      ? `campaign:${slugOfCampaignId(r.campaignId)}`
      : `mission:${slugOfCampaignId(r.campaignId)}/${missionLabel(r)}`,
    branches: [...r.branches].sort(),
    sessions: r.sessions,
    turns: r.turns,
    tokens: tot(r.tokens),
    costByModel: r.costByModel,
    costUsd: r.costUsd,
  }));
  const u = report.unattributed;
  return finish(rows, { segments: u.segments, turns: u.turns, branches: u.branches, tokens: tot(u.tokens), costByModel: u.costByModel, costUsd: u.costUsd });
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

function segmentTotalsByModel(dir: string): Record<string, Totals> {
  const out: Record<string, Totals> = {};
  const lines = readFileSync(join(dir, ".octobots/tokenomics/raw/segments.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  for (const l of lines) {
    const s = JSON.parse(l) as { tokens_by_model: Record<string, Record<string, number>> };
    for (const [model, t] of Object.entries(s.tokens_by_model)) {
      const sum = (out[model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
      sum.input += t.input_tokens ?? 0;
      sum.output += t.output_tokens ?? 0;
      sum.cacheRead += t.cache_read_input_tokens ?? 0;
      sum.cacheCreate += t.cache_creation_input_tokens ?? 0;
    }
  }
  return out;
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
    // Not vacuous: per-model cost is compared on the unattributed bucket too, over two models.
    expect(Object.keys(mjs.unattributed.costByModel).sort()).toEqual(["cheap", "dear"]);
    expect(ts).toEqual(mjs);
  });

  it("rollup.mjs campaign rows carry the AC5 shape (work_item_level, ref, parent, _octobots)", () => {
    const out = JSON.parse(readFileSync(join(dir, ".octobots/tokenomics/runs.json"), "utf8")) as {
      runs: Array<Record<string, unknown> & { _octobots: Record<string, unknown> }>;
      unattributed: { branches: string[] };
    };
    const camp = out.runs.filter((r) => r.work_item_level === "campaign");
    expect(camp.map((r) => r.work_item_ref).sort()).toEqual(["alpha", "alpha-ops", "beta", "delta", "gamma", "theta"]);
    for (const r of camp) {
      expect(r.parent_ref, String(r.work_item_ref)).toBeNull();
      expect(r._octobots.mission_id, String(r.work_item_ref)).toBeNull();
      expect(r._octobots.campaign, String(r.work_item_ref)).toBe(r.work_item_ref);
      const absorbed = fixture.cases.filter((c) => c.expect === `campaign:${String(r.work_item_ref)}`).map((c) => c.branch).sort();
      expect(r._octobots.branches, String(r.work_item_ref)).toEqual(absorbed);
      // A branch a campaign row absorbed is no longer reported as unattributed.
      for (const b of absorbed) expect(out.unattributed.branches).not.toContain(b);
      // Sizing, churn and build/iterate are mission concepts: null, never a guessed zero.
      for (const k of ["effort_days", "size_tshirt", "net_loc", "build_cost_usd", "iterate_cost_usd"]) expect(r[k], k).toBeNull();
    }
    // Every mission row still has a campaign parent.
    for (const r of out.runs.filter((x) => x.work_item_level !== "campaign")) expect(r.parent_ref).toBeTypeOf("string");
  });

  it("rollup.mjs's summary counts campaign rows apart and keeps them out of the missing-sizing NOTE", () => {
    const r = spawnSync("node", [ROLLUP, "--project-dir", dir, "--no-gh"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const missionRows = mjs.rows.filter((x) => x.target.startsWith("mission:")).length;
    const campaignRows = mjs.rows.length - missionRows;
    expect(r.stderr).toContain(`${missionRows} mission rows · ${campaignRows} campaign rows`);
    const note = r.stderr.split("\n").find((l) => l.includes("NOTE no authored sizing")) ?? "";
    // No fixture mission is sized, so every mission row is named and no campaign row is.
    expect(note.match(/M\d+/g)?.length).toBe(missionRows);
    expect(note).not.toContain("null");
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
  const t = { byModel: segmentTotalsByModel(dir) };
  let usd = 0;
  for (const [model, tt] of Object.entries(t.byModel)) {
    const m = PRICES.models[model]!;
    usd += tt.input * m.input_cost_per_token! + tt.output * m.output_cost_per_token! + tt.cacheRead * m.cache_read_input_token_cost!;
  }
  return usd;
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
      out.set(r.target, { ...r, tokens: { ...r.tokens }, costByModel: { ...r.costByModel }, rows: 1 });
      continue;
    }
    cur.rows += 1;
    cur.branches = [...new Set([...cur.branches, ...r.branches])].sort();
    cur.turns += r.turns;
    cur.sessions += r.sessions;
    cur.costUsd += r.costUsd;
    for (const [m, c] of Object.entries(r.costByModel)) cur.costByModel[m] = (cur.costByModel[m] ?? 0) + c;
    for (const k of ["input", "output", "cacheRead", "cacheCreate"] as const) cur.tokens[k] += r.tokens[k];
  }
  return [...out.values()];
}

const REPO_OCTOBOTS = join(HERE, "../../../.octobots");

/**
 * The real board to compare over (campaign § Test conventions rule 2): `OCTOBOTS_TOKENOMICS_COPY`
 * when QA names a copy of a project's `.octobots`, otherwise THIS repo's own `.octobots` - its
 * committed board always exists, and its local tokenomics data (segments, worklog, prices) is
 * taken when present. Never skipped: an unset env var (CI) still compares a real board.
 */
function copyRealBoard(): { dir: string; source: string } {
  const dir = mkTmp();
  const env = process.env.OCTOBOTS_TOKENOMICS_COPY;
  const oct = join(dir, ".octobots");
  if (env) {
    cpSync(env, oct, { recursive: true });
    return { dir, source: env };
  }
  cpSync(join(REPO_OCTOBOTS, "campaigns"), join(oct, "campaigns"), { recursive: true });
  for (const f of ["raw/segments.jsonl", "worklog.jsonl", "prices.json", "prices.local.json"]) {
    const from = join(REPO_OCTOBOTS, "tokenomics", f);
    if (existsSync(from)) {
      mkdirSync(dirname(join(oct, "tokenomics", f)), { recursive: true });
      cpSync(from, join(oct, "tokenomics", f));
    }
  }
  return { dir, source: REPO_OCTOBOTS };
}

/**
 * Segments (and worklog entries) built from the copied board's own vocabulary, appended to whatever
 * real segments it carries, so every precedence step meets the REAL board shape even where no
 * transcripts were collected (CI): every campaign slug bare and with `-m<n>` for each mission plus
 * one number past the last, every declared branch, a `session|branch` worklog entry per task label,
 * and branches that match nothing.
 */
function appendBoardDerivedSegments(dir: string): void {
  const oct = join(dir, ".octobots");
  const board = new BoardModel(oct);
  board.rebuild();
  const branches = new Set<string>(["main", "HEAD", "chore/matches-no-campaign"]);
  const worklog: Array<Record<string, unknown>> = [];
  for (const c of board.listCampaigns()) {
    const slug = slugOfCampaignId(c.folderPath);
    for (const b of [slug, `feat/${slug}`, `chore/${slug}-plan`]) branches.add(b);
    for (const b of readEstimate(join(oct, c.folderPath), "campaign").branches) branches.add(b);
    let max = 0;
    for (const m of board.listMissions(c.id)) {
      const n = Number(/^M(\d+)/i.exec(m.title)?.[1] ?? 0);
      max = Math.max(max, n);
      if (n) branches.add(`feat/${slug}-m${n}`).add(`feat/${slug}-m${n}-t1`);
      for (const b of readEstimate(join(oct, m.folderPath), "mission").branches) branches.add(b);
      for (const t of board.listTasks(m.id)) {
        const label = /T\d+\.\d+/i.exec(t.name)?.[0];
        if (!label) continue;
        const branch = `chore/worklog-${label.toLowerCase()}`;
        branches.add(branch);
        worklog.push({ session_id: `synthetic-parity:${branch}`, task: label, branch, state: "done", at: "2026-10-01T00:00:00.000Z" });
      }
    }
    branches.add(`feat/${slug}-m${max + 1}`);
  }
  const segs = [...branches].map((branch, i) => {
    const n = i + 1;
    return JSON.stringify({
      segment_id: `synthetic-parity:${branch}:main:${branch}`,
      session_id: `synthetic-parity:${branch}`,
      kind: "orchestrator",
      agent_type: null,
      branch,
      started_at: "2026-10-01T00:00:00.000Z",
      ended_at: "2026-10-01T00:01:00.000Z",
      turns: n,
      tokens_by_model: {
        "claude-sonnet-4-5": {
          input_tokens: n * 1000,
          output_tokens: n * 100,
          cache_read_input_tokens: n * 10,
          cache_creation_input_tokens: 0,
          cache_creation_5m_tokens: 0,
          cache_creation_1h_tokens: 0,
        },
      },
      tools: {},
    });
  });
  const tok = join(oct, "tokenomics");
  mkdirSync(join(tok, "raw"), { recursive: true });
  const append = (file: string, lines: string[]): void => {
    const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
  };
  append(join(tok, "raw/segments.jsonl"), segs);
  append(join(tok, "worklog.jsonl"), worklog.map((e) => JSON.stringify(e)));
}

describe("real board copy (OCTOBOTS_TOKENOMICS_COPY, else this repo's own .octobots)", () => {
  it("rollup.mjs and rollup.ts agree on a copy of a real .octobots, and the totals invariant holds", () => {
    const { dir } = copyRealBoard();
    appendBoardDerivedSegments(dir);
    if (!existsSync(join(dir, ".octobots/tokenomics/prices.json"))) {
      cpSync(join(PACK, "tokenomics/prices.json"), join(dir, ".octobots/tokenomics/prices.json"));
    }
    if (!existsSync(join(dir, ".octobots/tokenomics/prices.local.json")) && existsSync(join(PACK, "tokenomics/prices.local.json"))) {
      cpSync(join(PACK, "tokenomics/prices.local.json"), join(dir, ".octobots/tokenomics/prices.local.json"));
    }
    installPackYaml(dir);
    const mjs = runMjs(dir);
    const ts = runTs(dir, pricesOf(dir));
    // Not vacuous: the real board produced mission rows, campaign rows and unattributed work.
    expect(mjs.rows.some((r) => r.target.startsWith("mission:")), "a mission row").toBe(true);
    expect(mjs.rows.some((r) => r.target.startsWith("campaign:")), "a campaign row").toBe(true);
    expect(mjs.unattributed.segments, "unattributed segments").toBeGreaterThan(0);
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
      if (t.rows === 1) expect(t.costByModel, t.target).toEqual(m.costByModel);
    });
  });
});
