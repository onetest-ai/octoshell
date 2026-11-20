import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The seven-step attribution contract. The pack copy is generated; never edit it. */
export interface AttributionMission {
  id: string;
  campaign: string;
  missionKey: string | null;
  missionNum: number;
  declaredBranches: string[];
  tasks: { id: string | null }[];
}
export interface AttributionCampaign {
  slug: string;
  declaredBranches: string[];
}
export interface AttributionContext<
  M extends AttributionMission = AttributionMission,
  C extends AttributionCampaign = AttributionCampaign
> {
  windows: LedgerWindow[];
  missions: M[];
  campaigns: C[];
  workLog: Map<string, string>;
  missionByTaskLabel: Map<string, M | typeof AMBIGUOUS>;
}
export type AttributionTarget<
  M extends AttributionMission = AttributionMission,
  C extends AttributionCampaign = AttributionCampaign
> =
  | { kind: "mission"; mission: M; step: 0 | 1 | 2 | 3 | 4 }
  | { kind: "campaign"; campaign: C; step: 5 | 6 }
  | { kind: "unattributed"; step: 7 };

const AMBIGUOUS = Symbol("ambiguous-task-label");

export function makeAttributionContext<M extends AttributionMission, C extends AttributionCampaign>(
  board: { missions: M[]; campaigns: C[] },
  workLog: Map<string, string> = new Map(),
  windows: LedgerWindow[] = []
): AttributionContext<M, C> {
  const missions = [...board.missions].sort((a, b) =>
    a.campaign < b.campaign
      ? -1
      : a.campaign > b.campaign
        ? 1
        : a.missionNum - b.missionNum ||
          ((a.missionKey ?? "") < (b.missionKey ?? "")
            ? -1
            : (a.missionKey ?? "") > (b.missionKey ?? "")
              ? 1
              : 0)
  );
  const missionByTaskLabel = new Map<string, M | typeof AMBIGUOUS>();
  for (const m of missions) {
    for (const t of m.tasks) {
      if (!t.id) continue;
      const seen = missionByTaskLabel.get(t.id);
      missionByTaskLabel.set(t.id, seen === undefined || seen === m ? m : AMBIGUOUS);
    }
  }
  const campaigns = [...board.campaigns].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  );
  return { missions, campaigns, missionByTaskLabel, workLog, windows };
}

export function resolveAttribution<M extends AttributionMission, C extends AttributionCampaign>(
  branch: string,
  sessionId: string,
  ctx: AttributionContext<M, C>
): AttributionTarget<M, C> {
  for (const m of ctx.missions) {
    if (m.declaredBranches.includes(branch)) return { kind: "mission", mission: m, step: 1 };
  }

  const top = ctx.campaigns
    .filter((c) => c.slug && branch.includes(c.slug))
    .sort(
      (a, b) => b.slug.length - a.slug.length || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
    )[0];
  if (top) {
    const inCampaign = ctx.missions.filter((m) => m.campaign === top.slug);
    const key = branch.match(/-m(\d+[a-z]?)\b/i)?.[1]?.toLowerCase();
    if (key) {
      const hit = inCampaign.find((m) => m.missionKey === key);
      if (hit) return { kind: "mission", mission: hit, step: 2 };
    } else if (inCampaign.length === 1 && inCampaign[0]) {
      return { kind: "mission", mission: inCampaign[0], step: 3 };
    }
  }

  const label = ctx.workLog.get(`${sessionId}|${branch}`);
  const logged = label ? ctx.missionByTaskLabel.get(label) : undefined;
  if (logged && logged !== AMBIGUOUS) return { kind: "mission", mission: logged, step: 4 };

  const declared = ctx.campaigns.find((c) => c.declaredBranches.includes(branch));
  if (declared) return { kind: "campaign", campaign: declared, step: 5 };
  if (top) return { kind: "campaign", campaign: top, step: 6 };
  return { kind: "unattributed", step: 7 };
}

/** Stable board references for CLI consumers, including letter missions. */
export function attributionLabels(target: AttributionTarget): {
  kind: AttributionTarget["kind"];
  campaign: string | null;
  mission: string | null;
  step: number;
} {
  return {
    kind: target.kind,
    campaign:
      target.kind === "mission"
        ? target.mission.campaign
        : target.kind === "campaign"
          ? target.campaign.slug
          : null,
    mission: target.kind === "mission" ? target.mission.id : null,
    step: target.step
  };
}
export interface SegmentAttribution {
  kind: AttributionTarget["kind"];
  ref: string | null;
  step: number;
  started_at: string | null;
}
export function segmentAttribution(
  target: AttributionTarget,
  startedAt: string | null
): SegmentAttribution {
  const { kind, campaign, mission, step } = attributionLabels(target);
  return { kind, ref: mission ? `${campaign}/${mission}` : campaign, step, started_at: startedAt };
}

/** Existing Codex compatibility fallback: consult delivery windows only after step 7. */
export interface LedgerWindow {
  campaign: string;
  missionKey: string;
  start: string;
  end: string;
}
export interface AttributionSegment {
  branch: string;
  sessionId: string;
  source?: string;
  startedAt: string | null;
  endedAt: string | null;
}

export function loadLedgerWindows(projectDir: string): LedgerWindow[] {
  const dir = join(projectDir, ".agents", "telemetry", "delivery");
  const spans = new Map<
    string,
    { campaign: string; missionKey: string; start: string | null; end: string | null }
  >();
  if (!existsSync(dir)) return [];
  for (const file of readdirSync(dir)) {
    if (!/^events-.*\.jsonl$/.test(file)) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      let e: { plan?: string; at?: string; event?: string; level?: string; ref?: string } | null;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e?.plan || !e.at || !e.event) continue;
      const key =
        e.level === "mission"
          ? /^M(\d+[a-z]?)$/.exec(e.ref ?? "")?.[1]
          : e.level === "task"
            ? /^T(\d+[a-z]?)\./.exec(e.ref ?? "")?.[1]
            : null;
      if (!key || e.event === "created" || e.event === "estimated") continue;
      const campaign = e.plan.split("/run-")[0]!;
      const span = spans.get(`${campaign}/${key}`) ?? {
        campaign,
        missionKey: key,
        start: null,
        end: null
      };
      if (
        (e.event === "dispatched" || e.event === "first_commit") &&
        (!span.start || e.at < span.start)
      )
        span.start = e.at;
      if (!span.end || e.at > span.end) span.end = e.at;
      spans.set(`${campaign}/${key}`, span);
    }
  }
  return [...spans.values()].flatMap((s) =>
    s.start && s.end && s.end >= s.start ? [{ ...s, start: s.start, end: s.end }] : []
  );
}

export function resolveSegmentAttribution<
  M extends AttributionMission,
  C extends AttributionCampaign
>(segment: AttributionSegment, ctx: AttributionContext<M, C>): AttributionTarget<M, C> {
  const target = resolveAttribution(segment.branch, segment.sessionId, ctx);
  if (target.kind !== "unattributed" || segment.source !== "codex") return target;
  const start = Date.parse(segment.startedAt ?? segment.endedAt ?? "");
  const end = Date.parse(segment.endedAt ?? segment.startedAt ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return target;
  const mid = (start + end) / 2;
  const hits = ctx.windows.flatMap((w) => {
    const mission = ctx.missions.find(
      (m) => m.campaign === w.campaign && m.missionKey === w.missionKey
    );
    return mission && mid >= Date.parse(w.start) && mid <= Date.parse(w.end) ? [mission] : [];
  });
  return hits.length === 1 && hits[0] ? { kind: "mission", mission: hits[0], step: 0 } : target;
}
