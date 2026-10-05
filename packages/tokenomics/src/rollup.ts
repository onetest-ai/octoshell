import { join } from "node:path";
import type { BoardModel, Campaign, Mission, Task } from "@octoshell/board";
import { loadWorkLog, readEstimate } from "./estimates.js";
import { cacheReadCost, costOf, costOfModel, loadPrices, unpricedModels, type PriceTable } from "./prices.js";
import {
  addTotals,
  emptyEstimate,
  emptyTotals,
  type Attribution,
  type MissionRun,
  type Report,
  type Segment,
  type TaskRun,
  type TokenTotals,
  type TranscriptSource,
} from "./types.js";

export interface RollupOptions {
  repoRoot: string;
  /**
   * The board's artifacts root (the directory BoardModel was built from).
   * `folderPath` on every entity is relative to it, so estimates cannot be read
   * without it.
   */
  artifactsRoot: string;
  board: BoardModel;
  source: TranscriptSource;
  prices?: PriceTable;
  /** Injected so output is deterministic in tests. */
  now?: () => Date;
}

/**
 * Join measured segments to the board and price them.
 *
 * Board reading goes through `BoardModel` — the campaign/mission/task tree is
 * already parsed and validated there, so this never re-implements it. The only
 * board content read directly is the `## Tokenomics` block, via each entity's
 * `folderPath`.
 */
export function rollup(opts: RollupOptions): Report {
  const { repoRoot, artifactsRoot, board, source } = opts;
  const prices = opts.prices ?? loadPrices();
  const now = opts.now ?? (() => new Date());

  const segments = source.collect();
  const workLog = loadWorkLog(repoRoot);

  // Index every mission once: id -> {mission, tasks, estimate}.
  const missions = board
    .listCampaigns()
    .flatMap((c) => board.listMissions(c.id))
    .map((m) => ({
      mission: m,
      tasks: board.listTasks(m.id),
      estimate: readEstimate(join(artifactsRoot, m.folderPath), "mission"),
    }));

  const campaigns: CampaignEntry[] = board.listCampaigns().map((c) => ({
    campaign: c,
    slug: c.folderPath.split("/").filter(Boolean).pop() ?? "",
    declaredBranches: readEstimate(join(artifactsRoot, c.folderPath), "campaign").branches,
  }));

  // A task label implies its mission, so the work log resolves the mission too - otherwise an
  // off-convention branch would still be unattributable, which is exactly the case the log exists
  // to fix. A label carried by tasks in more than one mission names none of them.
  const missionByTaskLabel = new Map<string, MissionEntry | typeof AMBIGUOUS>();
  for (const e of missions) {
    for (const t of e.tasks) {
      const label = taskLabel(t);
      if (!label) continue;
      const seen = missionByTaskLabel.get(label);
      missionByTaskLabel.set(label, seen === undefined || seen === e ? e : AMBIGUOUS);
    }
  }

  const ctx: AttributionContext = {
    missions: [...missions].sort(byCampaignThenNumber(campaigns)),
    campaigns,
    workLog,
    missionByTaskLabel,
  };

  const grouped = new Map<string, Segment[]>();
  const groupedCampaign = new Map<string, Segment[]>();
  const unattributed: Segment[] = [];
  const attributionOf = new Map<string, Attribution>();

  for (const seg of segments) {
    const target = resolveAttribution(seg.branch, seg.sessionId, ctx);
    if (target.kind === "unattributed") {
      unattributed.push(seg);
      continue;
    }
    const [bucket, key] =
      target.kind === "mission"
        ? [grouped, target.mission.mission.id]
        : [groupedCampaign, target.campaign.campaign.id];
    const list = bucket.get(key) ?? [];
    list.push(seg);
    bucket.set(key, list);
  }

  const runs: MissionRun[] = [];
  for (const entry of missions) {
    const segs = grouped.get(entry.mission.id);
    if (!segs?.length) continue;
    runs.push(buildMissionRun(entry, segs, prices, workLog, attributionOf, artifactsRoot));
  }
  for (const c of campaigns) {
    const segs = groupedCampaign.get(c.campaign.id);
    if (!segs?.length) continue;
    runs.push(buildCampaignRun(c, segs, prices));
  }
  runs.sort((a, b) => b.costUsd - a.costUsd);

  const unattrByModel = sumByModel(unattributed);
  const seenModels = new Set<string>();
  for (const s of segments) for (const m of Object.keys(s.tokensByModel)) seenModels.add(m);

  return {
    generatedAt: now().toISOString(),
    agentTool: source.agentTool,
    pricesFetchedAt: prices.fetched_at ?? null,
    runs,
    unattributed: {
      segments: unattributed.length,
      turns: unattributed.reduce((n, s) => n + s.turns, 0),
      branches: [...new Set(unattributed.map((s) => s.branch))].sort(),
      tokens: totalsOf(unattrByModel),
      costByModel: Object.fromEntries(Object.entries(unattrByModel).map(([m, t]) => [m, round2(costOfModel(prices, m, t))])),
      costUsd: round2(costOf(prices, unattrByModel)),
    },
    unpricedModels: unpricedModels(prices, seenModels),
  };
}

interface MissionEntry {
  mission: Mission;
  tasks: Task[];
  estimate: ReturnType<typeof emptyEstimate>;
}

interface CampaignEntry {
  campaign: Campaign;
  /** The folder slug, which is what a branch name actually contains (ids are opaque). */
  slug: string;
  declaredBranches: string[];
}

/** A task label carried by tasks in more than one mission: it identifies none of them. */
const AMBIGUOUS = Symbol("ambiguous-task-label");

export interface AttributionContext {
  /** Sorted by (campaign slug, mission number) so a branch declared twice resolves the same way every run. */
  missions: MissionEntry[];
  /** EVERY campaign, including ones with no missions. */
  campaigns: CampaignEntry[];
  /** From `loadWorkLog`; only the branch-qualified `session|branch` keys are consulted. */
  workLog: Map<string, string>;
  missionByTaskLabel: Map<string, MissionEntry | typeof AMBIGUOUS>;
}

export type AttributionTarget =
  | { kind: "mission"; mission: MissionEntry; step: 1 | 2 | 3 | 4 }
  | { kind: "campaign"; campaign: CampaignEntry; step: 5 | 6 }
  | { kind: "unattributed"; step: 7 };

function byCampaignThenNumber(campaigns: CampaignEntry[]): (a: MissionEntry, b: MissionEntry) => number {
  const slug = new Map(campaigns.map((c) => [c.campaign.id, c.slug]));
  const key = (e: MissionEntry): [string, number] => [slug.get(e.mission.campaignId) ?? "", missionNumber(e.mission) ?? 0];
  return (a, b) => {
    const [sa, na] = key(a);
    const [sb, nb] = key(b);
    return sa < sb ? -1 : sa > sb ? 1 : na - nb;
  };
}

/**
 * Where does a (branch, session) pair belong? The first step that hits wins. This is the only place
 * attribution is decided; `packs/.../rollup.mjs` carries the same table and the parity test holds
 * them together.
 *
 *  1. A mission declares the branch (`tokenomics.branches`).
 *  2. The longest campaign slug in the branch, plus `-m<n>`: that campaign's mission n. A `-m<n>`
 *     naming no mission falls through - it must not jump ahead of a recorded worklog fact.
 *  3. That slug, no `-m<n>`, and the campaign has exactly one mission.
 *  4. The work log recorded this exact session on this exact branch against a task id that belongs
 *     to one mission. The bare-session key never attributes a mission: it follows a session across
 *     branches, so it would drag every branch the session touched into one mission.
 *  5. A campaign declares the branch.
 *  6. The longest campaign slug in the branch: the campaign-level bucket.
 *  7. Unattributed.
 */
export function resolveAttribution(branch: string, sessionId: string, ctx: AttributionContext): AttributionTarget {
  for (const e of ctx.missions) {
    if (e.estimate.branches.includes(branch)) return { kind: "mission", mission: e, step: 1 };
  }

  const top = ctx.campaigns
    .filter((c) => c.slug && branch.includes(c.slug))
    .sort((a, b) => b.slug.length - a.slug.length || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))[0];
  if (top) {
    const inCampaign = ctx.missions.filter((e) => e.mission.campaignId === top.campaign.id);
    const num = /-m(\d+)\b/i.exec(branch)?.[1];
    if (num) {
      const hit = inCampaign.find((e) => missionNumber(e.mission) === Number(num));
      if (hit) return { kind: "mission", mission: hit, step: 2 };
    } else if (inCampaign.length === 1 && inCampaign[0]) {
      return { kind: "mission", mission: inCampaign[0], step: 3 };
    }
  }

  const label = ctx.workLog.get(`${sessionId}|${branch}`);
  const logged = label ? ctx.missionByTaskLabel.get(label) : undefined;
  if (logged && logged !== AMBIGUOUS) return { kind: "mission", mission: logged, step: 4 };

  const declared = [...ctx.campaigns]
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .find((c) => c.declaredBranches.includes(branch));
  if (declared) return { kind: "campaign", campaign: declared, step: 5 };

  if (top) return { kind: "campaign", campaign: top, step: 6 };
  return { kind: "unattributed", step: 7 };
}

function missionNumber(m: Mission): number | null {
  const n = /M(\d+)/i.exec(m.title)?.[1];
  return n ? Number(n) : null;
}

function taskNumber(t: Task): number | null {
  const n = /T\d+\.(\d+)/i.exec(t.name)?.[1];
  return n ? Number(n) : null;
}

function taskLabel(t: Task): string | null {
  return /T(\d+\.\d+)/i.exec(t.name)?.[0] ?? null;
}

/** The campaign-level bucket: spend attributed to a campaign that belongs to none of its missions. */
function buildCampaignRun(entry: CampaignEntry, segs: Segment[], prices: PriceTable): MissionRun {
  return {
    ...metered(segs, prices),
    scope: "campaign",
    missionId: null,
    missionTitle: entry.campaign.name,
    campaignId: entry.campaign.id,
    estimate: { ...emptyEstimate(), branches: entry.declaredBranches },
    tasks: [],
  };
}

function metered(segs: Segment[], prices: PriceTable) {
  const byModel = sumByModel(segs);
  const cost = costOf(prices, byModel);
  const orchCost = costOf(prices, sumByModel(segs.filter((s) => s.kind === "orchestrator")));
  return {
    branches: [...new Set(segs.map((s) => s.branch))].sort(),
    sessions: new Set(segs.map((s) => s.sessionId)).size,
    turns: segs.reduce((n, s) => n + s.turns, 0),
    subagentDispatches: segs.filter((s) => s.kind === "subagent").length,
    orchestratorCostPct: cost > 0 ? Math.round((100 * orchCost) / cost) : 100,
    cacheReadSharePct: cost > 0 ? Math.round((100 * cacheReadCost(prices, byModel)) / cost) : 0,
    tokens: totalsOf(byModel),
    // Priced per model, never apportioned by token share: models differ ~2.5x per token, so an
    // equal token split is not an equal cost split.
    costByModel: Object.fromEntries(Object.entries(byModel).map(([m, t]) => [m, round2(costOfModel(prices, m, t))])),
    costUsd: round2(cost),
  };
}

function buildMissionRun(
  entry: MissionEntry,
  segs: Segment[],
  prices: PriceTable,
  workLog: Map<string, string>,
  attributionOf: Map<string, Attribution>,
  artifactsRoot: string,
): MissionRun {
  return {
    ...metered(segs, prices),
    scope: "mission",
    missionId: entry.mission.id,
    missionTitle: entry.mission.title,
    campaignId: entry.mission.campaignId,
    estimate: entry.estimate,
    tasks: buildTaskRuns(entry, segs, costOf(prices, sumByModel(segs)), prices, workLog, attributionOf, artifactsRoot),
  };
}

function buildTaskRuns(
  entry: MissionEntry,
  segs: Segment[],
  missionCost: number,
  prices: PriceTable,
  workLog: Map<string, string>,
  attributionOf: Map<string, Attribution>,
  artifactsRoot: string,
): TaskRun[] {
  const missionNum = missionNumber(entry.mission);
  const byTask = new Map<string, Segment[]>();

  for (const seg of segs) {
    // Recorded fact first, inference second.
    const logged = workLog.get(`${seg.sessionId}|${seg.branch}`) ?? workLog.get(seg.sessionId);
    const inferred = /-t(\d+)(?:[-_.].*)?$/i.exec(seg.branch)?.[1];
    const num = logged ? logged.split(".")[1] : inferred;
    const key = num && missionNum !== null ? `T${missionNum}.${num}` : MISSION_LEVEL;
    attributionOf.set(seg.segmentId, logged ? "worklog" : inferred ? "branch-inference" : "mission-level");
    const list = byTask.get(key) ?? [];
    list.push(seg);
    byTask.set(key, list);
  }

  const rows: TaskRun[] = [];
  for (const [key, taskSegs] of byTask) {
    const declared = entry.tasks.find((t) => taskLabel(t) === key);
    const byModel = sumByModel(taskSegs);
    const cost = costOf(prices, byModel);
    const subagents = taskSegs.filter((s) => s.kind === "subagent");
    const orchCost = costOf(prices, sumByModel(taskSegs.filter((s) => s.kind === "orchestrator")));
    const attributions = [
      ...new Set(taskSegs.map((s) => attributionOf.get(s.segmentId) ?? "mission-level")),
    ];

    rows.push({
      taskId: key === MISSION_LEVEL ? null : key,
      name:
        declared?.name ??
        (key === MISSION_LEVEL ? "Mission-level work (planning, integration, gate)" : "(not on the board)"),
      status: declared?.status ?? null,
      estimate: declared ? readEstimate(join(artifactsRoot, declared.folderPath), "task") : emptyEstimate(),
      branches: [...new Set(taskSegs.map((s) => s.branch))].sort(),
      turns: taskSegs.reduce((n, s) => n + s.turns, 0),
      subagentDispatches: subagents.length,
      orchestratorCostPct: cost > 0 ? Math.round((100 * orchCost) / cost) : 100,
      // Mixed provenance within one task reads as the weaker of the two.
      attribution: attributions.length === 1 ? (attributions[0] ?? null) : "branch-inference",
      tokens: totalsOf(byModel),
      costUsd: round2(cost),
      costSharePct: missionCost > 0 ? Math.round((100 * cost) / missionCost) : 0,
      unmeasured: false,
    });
  }

  // A task declared on the board but never measured reads as $0 rather than
  // vanishing — a mission's task list is never silently short.
  for (const t of entry.tasks) {
    const label = taskLabel(t);
    if (!label || rows.some((r) => r.taskId === label)) continue;
    rows.push({
      taskId: label,
      name: t.name,
      status: t.status,
      estimate: readEstimate(join(artifactsRoot, t.folderPath), "task"),
      branches: [],
      turns: 0,
      subagentDispatches: 0,
      orchestratorCostPct: 100,
      attribution: null,
      tokens: emptyTotals(),
      costUsd: 0,
      costSharePct: 0,
      unmeasured: true,
    });
  }

  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

const MISSION_LEVEL = "(mission-level)";

function sumByModel(segs: Segment[]): Record<string, TokenTotals> {
  const out: Record<string, TokenTotals> = {};
  for (const s of segs) {
    for (const [model, t] of Object.entries(s.tokensByModel)) {
      out[model] = addTotals(out[model] ?? emptyTotals(), t);
    }
  }
  return out;
}

function totalsOf(byModel: Record<string, TokenTotals>): TokenTotals {
  return Object.values(byModel).reduce((acc, t) => addTotals(acc, t), emptyTotals());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Unused today, but taskNumber keeps the label parsing honest for future sorting. */
export const __internals = { resolveAttribution, taskNumber };
