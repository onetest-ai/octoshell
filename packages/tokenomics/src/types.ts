/** The four token classes every provider bills separately. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  /** TTL-agnostic total. NEVER priced directly — see `cacheCreate5m`/`cacheCreate1h`. */
  cacheCreate: number;
  /** Cache writes bill at different rates by TTL (~1.25x input vs ~2x). */
  cacheCreate5m: number;
  cacheCreate1h: number;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate5m: 0, cacheCreate1h: 0 };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheCreate5m: a.cacheCreate5m + b.cacheCreate5m,
    cacheCreate1h: a.cacheCreate1h + b.cacheCreate1h,
  };
}

/**
 * One measured slice of agent work: a single (session x agent x branch) bucket.
 *
 * This is the durable record. Agent transcripts live outside the repo and are
 * pruned without warning, so segments are collected early and committed —
 * everything downstream is derived from them and can be recomputed.
 */
export interface Segment {
  /** Stable identity, so re-collection updates a segment rather than duplicating it. */
  segmentId: string;
  sessionId: string;
  /** `orchestrator` = the main thread; `subagent` = a dispatched agent. */
  kind: "orchestrator" | "subagent";
  /** Sub-agent type when known (e.g. `python-dev`), else null. */
  agentType: string | null;
  /** Set when the subagent ran inside a workflow, for grouping. */
  workflowId: string | null;
  /** Git branch the work happened on — the fallback attribution key. */
  branch: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Model exchanges, deduplicated by request id. */
  turns: number;
  tokensByModel: Record<string, TokenTotals>;
  /** Tool name -> call count. */
  tools: Record<string, number>;
}

/**
 * Where segments come from. Claude Code today; Codex/Gemini can be added
 * without touching the rollup, which is why this is an interface rather than a
 * direct filesystem read.
 */
export interface TranscriptSource {
  /** Stable name, recorded on the submission header (e.g. `claude-code`). */
  readonly agentTool: string;
  /** Every segment this source can see. Implementations should stream, not slurp. */
  collect(): Segment[];
}

/** One `set-status.js` transition, recorded by the work-log hook. */
export interface WorkLogEntry {
  sessionId: string;
  /** Exactly one of these is set. */
  task?: string;
  mission?: string;
  state: "active" | "done";
  branch: string | null;
  at: string;
}

/** How a segment was tied to a task — a recorded fact, or a guess. */
export type Attribution = "worklog" | "branch-inference" | "mission-level";

/** Effort/size a human authored at planning time. Nothing derives these. */
export interface Estimate {
  effortDays: number | null;
  sizeTshirt: string | null;
  complexityScore: number | null;
  selfSize: string | null;
  maturity: string | null;
  /** Declared branches, when the naming convention doesn't apply. */
  branches: string[];
  /** True when the estimate was reconstructed after the work shipped. */
  estimatedRetrospectively: boolean;
}

export function emptyEstimate(): Estimate {
  return {
    effortDays: null,
    sizeTshirt: null,
    complexityScore: null,
    selfSize: null,
    maturity: null,
    branches: [],
    estimatedRetrospectively: false,
  };
}

/** A task's measured slice of its mission. */
export interface TaskRun {
  /** null for the mission-level bucket (planning, integration, the gate). */
  taskId: string | null;
  name: string;
  status: string | null;
  estimate: Estimate;
  branches: string[];
  turns: number;
  subagentDispatches: number;
  orchestratorCostPct: number;
  attribution: Attribution | null;
  tokens: TokenTotals;
  costUsd: number;
  /** Share of the parent mission's cost. */
  costSharePct: number;
  /** Declared on the board but never measured — reported at zero, never dropped. */
  unmeasured: boolean;
}

/** One mission: the unit that ships behind a PR and carries acceptance criteria. */
export interface MissionRun {
  missionId: string;
  missionTitle: string;
  campaignId: string;
  estimate: Estimate;
  branches: string[];
  sessions: number;
  turns: number;
  subagentDispatches: number;
  orchestratorCostPct: number;
  cacheReadSharePct: number;
  tokens: TokenTotals;
  /** Priced per model, never apportioned by token share — models differ ~2.5x. */
  costByModel: Record<string, number>;
  costUsd: number;
  tasks: TaskRun[];
}

/** Work that maps to no mission. Reported, never dropped. */
export interface Unattributed {
  segments: number;
  turns: number;
  branches: string[];
  tokens: TokenTotals;
  costUsd: number;
}

export interface Report {
  generatedAt: string;
  agentTool: string;
  pricesFetchedAt: string | null;
  runs: MissionRun[];
  unattributed: Unattributed;
  /** Models seen in transcripts with no price entry — their cost reads as 0. */
  unpricedModels: string[];
}
