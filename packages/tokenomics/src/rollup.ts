import { join } from "node:path";
import type { BoardModel, Mission, Task } from "@octoshell/board";
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
      estimate: readEstimate(join(artifactsRoot, m.folderPath), "mission.md"),
    }));

  const grouped = new Map<string, Segment[]>();
  const unattributed: Segment[] = [];
  const attributionOf = new Map<string, Attribution>();

  // Campaign id -> folder slug, which is what a branch name actually contains.
  const slugById = new Map(
    board.listCampaigns().map((c) => [c.id, c.folderPath.split("/").filter(Boolean).pop() ?? ""]),
  );

  // A task label implies its mission, so the work log resolves the mission too —
  // otherwise an off-convention branch would still be unattributable, which is
  // exactly the case the log exists to fix.
  const missionByTaskLabel = new Map<string, MissionEntry>();
  for (const e of missions) {
    for (const t of e.tasks) {
      const label = taskLabel(t);
      if (label) missionByTaskLabel.set(label, e);
    }
  }

  for (const seg of segments) {
    const loggedTask = workLog.get(`${seg.sessionId}|${seg.branch}`) ?? workLog.get(seg.sessionId);
    const entry =
      matchMission(seg.branch, missions, slugById) ??
      (loggedTask ? missionByTaskLabel.get(loggedTask) ?? null : null);
    if (!entry) {
      unattributed.push(seg);
      continue;
    }
    const list = grouped.get(entry.mission.id) ?? [];
    list.push(seg);
    grouped.set(entry.mission.id, list);
  }

  const runs: MissionRun[] = [];
  for (const entry of missions) {
    const segs = grouped.get(entry.mission.id);
    if (!segs?.length) continue;
    runs.push(buildMissionRun(entry, segs, prices, workLog, attributionOf, artifactsRoot));
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

/** Campaign ids are opaque (`folder:campaigns/<slug>`); branches carry the slug. */
function campaignSlug(m: Mission, byId: Map<string, string>): string {
  return byId.get(m.campaignId) ?? "";
}

/**
 * Map a branch to a mission. An explicit `branches:` declaration wins; otherwise
 * match the longest campaign SLUG appearing in the branch, then disambiguate by
 * an `m<n>` token, falling back to the campaign's only mission.
 *
 * Branch discipline is what makes the fallback work — which is exactly why the
 * work log exists for the task level, where guessing hurt most.
 */
function matchMission(
  branch: string,
  missions: MissionEntry[],
  slugById: Map<string, string>,
): MissionEntry | null {
  for (const e of missions) if (e.estimate.branches.includes(branch)) return e;

  const slugs = [...new Set(missions.map((e) => campaignSlug(e.mission, slugById)))]
    .filter((slug) => slug && branch.includes(slug))
    .sort((a, b) => b.length - a.length);
  if (!slugs.length) return null;

  const inCampaign = missions.filter((e) => campaignSlug(e.mission, slugById) === slugs[0]);
  const num = /-m(\d+)\b/i.exec(branch)?.[1];
  if (num) return inCampaign.find((e) => missionNumber(e.mission) === Number(num)) ?? null;
  return inCampaign.length === 1 ? (inCampaign[0] ?? null) : null;
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

function buildMissionRun(
  entry: MissionEntry,
  segs: Segment[],
  prices: PriceTable,
  workLog: Map<string, string>,
  attributionOf: Map<string, Attribution>,
  artifactsRoot: string,
): MissionRun {
  const byModel = sumByModel(segs);
  const cost = costOf(prices, byModel);
  const orchestrator = segs.filter((s) => s.kind === "orchestrator");
  const subagents = segs.filter((s) => s.kind === "subagent");
  const orchCost = costOf(prices, sumByModel(orchestrator));

  return {
    missionId: entry.mission.id,
    missionTitle: entry.mission.title,
    campaignId: entry.mission.campaignId,
    estimate: entry.estimate,
    branches: [...new Set(segs.map((s) => s.branch))].sort(),
    sessions: new Set(segs.map((s) => s.sessionId)).size,
    turns: segs.reduce((n, s) => n + s.turns, 0),
    subagentDispatches: subagents.length,
    orchestratorCostPct: cost > 0 ? Math.round((100 * orchCost) / cost) : 100,
    cacheReadSharePct: cost > 0 ? Math.round((100 * cacheReadCost(prices, byModel)) / cost) : 0,
    tokens: totalsOf(byModel),
    // Priced per model, never apportioned by token share: models differ ~2.5x
    // per token, so an equal token split is not an equal cost split.
    costByModel: Object.fromEntries(
      Object.entries(byModel).map(([m, t]) => [m, round2(costOfModel(prices, m, t))]),
    ),
    costUsd: round2(cost),
    tasks: buildTaskRuns(entry, segs, cost, prices, workLog, attributionOf, artifactsRoot),
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
      estimate: declared ? readEstimate(join(artifactsRoot, declared.folderPath), "task.md") : emptyEstimate(),
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
      estimate: readEstimate(join(artifactsRoot, t.folderPath), "task.md"),
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
export const __internals = { matchMission, taskNumber, campaignSlug };
