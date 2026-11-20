import { makeAttributionContext, resolveAttribution, resolveSegmentAttribution, loadLedgerWindows, segmentAttribution, type SegmentAttribution } from "./attribution.js";
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

  const ctx = makeAttributionContext({
    missions: missions.map((entry) => ({
      id: boardId(entry.mission.title, entry.mission.folderPath, "mission") ?? "",
      campaign: campaigns.find((c) => c.campaign.id === entry.mission.campaignId)?.slug ?? "",
      tracker: `${entry.mission.description}\n${entry.mission.notes ?? ""}`.match(/Tracker:\s*(\S+#\d+)/)?.[1] ?? null,
      missionKey: missionKey(entry.mission), missionNum: missionNumber(entry.mission) ?? 0,
      declaredBranches: entry.estimate.branches, tasks: entry.tasks.map((t) => ({ id: taskLabel(t) })), entry,
    })),
    campaigns,
  }, workLog, segments.some((s) => s.source === "codex") ? loadLedgerWindows(repoRoot) : []);
  const segmentAttributions: Record<string, SegmentAttribution> = Object.create(null);

  const grouped = new Map<string, Segment[]>();
  const groupedCampaign = new Map<string, Segment[]>();
  const unattributed: Segment[] = [];
  const attributionOf = new Map<string, Attribution>();

  for (const seg of segments) {
    const target = resolveSegmentAttribution(seg, ctx);
    segmentAttributions[seg.segmentId] = segmentAttribution(target, seg.startedAt);
    if (target.step === 0) attributionOf.set(seg.segmentId, "ledger-window");
    if (target.kind === "unattributed") {
      unattributed.push(seg);
      continue;
    }
    const [bucket, key] =
      target.kind === "mission"
        ? [grouped, target.mission.entry.mission.id]
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
    segmentAttributions,
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

/**
 * The board id of a mission or task, derived exactly as `rollup.mjs` derives it (`splitTitle` with its
 * folder fallback), because step 2 matches the mission number and step 4 matches the task id: two
 * derivations would attribute the same segment differently. The `<id> - <name>` title prefix wins;
 * otherwise the folder slug (`m3-...` -> `M3`, `t3-1-...` -> `T3.1`). An id that appears later in a
 * title ("Port the T2.1 follow-up") is prose, not the entity's id.
 */
function boardId(title: string, folderPath: string, kind: "mission" | "task"): string | null {
  const fromTitle = /^\s*([MT]\d+[a-z]?(?:\.\d+)?)\s*[-–—:]\s*(.+)$/.exec(title)?.[1];
  if (fromTitle) return fromTitle;
  const folder = folderPath.split("/").filter(Boolean).pop() ?? "";
  if (kind === "mission") {
    const n = /^m(\d+[a-z]?)(?![a-z\d])/i.exec(folder)?.[1];
    return n ? `M${n.toLowerCase()}` : folder || null;
  }
  const t = /^t(\d+[a-z]?)-(\d+)/i.exec(folder);
  return t ? `T${t[1]!.toLowerCase()}.${t[2]}` : null;
}

/**
 * `rollup.mjs`'s `missionKey`: the mission's full id without the `M` ("6", "6b"); null when the board
 * id is not an `M<n>[letter]` id. Missions are matched by this key, never by the bare number: M6 and
 * M6b are different missions.
 */
function missionKey(m: Mission): string | null {
  const key = /^M(\d+[a-z]?)$/i.exec(boardId(m.title, m.folderPath, "mission") ?? "")?.[1];
  return key ? key.toLowerCase() : null;
}

/** `rollup.mjs`'s `missionNum`: the numeric part of the mission key, used only to sort (6 < 6b < 7). */
function missionNumber(m: Mission): number | null {
  const key = missionKey(m);
  return key ? parseInt(key, 10) : null;
}

function taskNumber(t: Task): number | null {
  const n = /^T\d+[a-z]?\.(\d+)$/.exec(taskLabel(t) ?? "")?.[1];
  return n ? Number(n) : null;
}

function taskLabel(t: Task): string | null {
  return boardId(t.name, t.folderPath, "task");
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

function metered(segs: Segment[], prices: PriceTable, claudeCounters = false) {
  const byModel = sumByModel(segs);
  const claude = claudeCounters ? segs.filter((s) => s.source !== "codex") : segs;
  const claudeByModel = sumByModel(claude);
  const claudeCost = costOf(prices, claudeByModel);
  const orchCost = costOf(prices, sumByModel(claude.filter((s) => s.kind === "orchestrator")));
  return {
    branches: [...new Set(segs.map((s) => s.branch))].sort(),
    sessions: new Set(claude.map((s) => s.sessionId)).size,
    turns: claude.reduce((n, s) => n + s.turns, 0),
    subagentDispatches: claude.filter((s) => s.kind === "subagent").length,
    orchestratorCostPct: claudeCost > 0 ? Math.round((100 * orchCost) / claudeCost) : 100,
    cacheReadSharePct: claudeCost > 0 ? Math.round((100 * cacheReadCost(prices, claudeByModel)) / claudeCost) : 0,
    tokens: totalsOf(byModel),
    // Priced per model, never apportioned by token share: models differ ~2.5x per token, so an
    // equal token split is not an equal cost split.
    costByModel: Object.fromEntries(Object.entries(byModel).map(([m, t]) => [m, round2(costOfModel(prices, m, t))])),
    costUsd: round2(costOf(prices, byModel)),
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
    ...metered(segs, prices, true),
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
  const missionK = missionKey(entry.mission);
  const byTask = new Map<string, Segment[]>();

  for (const seg of segs) {
    // Recorded fact first, inference second.
    const logged = workLog.get(`${seg.sessionId}|${seg.branch}`) ?? workLog.get(seg.sessionId);
    const inferred = /-t(\d+)(?:[-_.].*)?$/i.exec(seg.branch)?.[1];
    const num = logged ? logged.split(".")[1] : inferred;
    const key = num && missionK !== null ? `T${missionK}.${num}` : MISSION_LEVEL;
    attributionOf.set(seg.segmentId, logged ? "worklog" : inferred ? "branch-inference" : attributionOf.get(seg.segmentId) ?? "mission-level");
    const list = byTask.get(key) ?? [];
    list.push(seg);
    byTask.set(key, list);
  }

  const rows: TaskRun[] = [];
  for (const [key, taskSegs] of byTask) {
    const declared = entry.tasks.find((t) => taskLabel(t) === key);
    const byModel = sumByModel(taskSegs);
    const cost = costOf(prices, byModel);
    const claude = taskSegs.filter((s) => s.source !== "codex");
    const claudeCost = costOf(prices, sumByModel(claude));
    const subagents = claude.filter((s) => s.kind === "subagent");
    const orchCost = costOf(prices, sumByModel(claude.filter((s) => s.kind === "orchestrator")));
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
      turns: claude.reduce((n, s) => n + s.turns, 0),
      subagentDispatches: subagents.length,
      orchestratorCostPct: claudeCost > 0 ? Math.round((100 * orchCost) / claudeCost) : 100,
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
