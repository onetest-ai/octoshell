export interface Campaign {
  id: string;
  name: string;
  isDefault: boolean;
  description: string;
  acceptanceCriteria: string;
  /** Free-form appended prose (decisions, rationale, sign-offs), preserved verbatim. */
  notes?: string;
  target: string;
  status: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface Mission {
  id: string;
  campaignId: string;
  title: string;
  status: string;
  description: string;
  acceptanceCriteria: string;
  /** Authored planning estimate from the entity's `tokenomics` field, when present. */
  tokenomics?: Record<string, unknown>;
  /** Free-form appended prose (decisions, rationale, sign-offs), preserved verbatim. */
  notes?: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  missionId: string;
  name: string;
  status: string;
  description: string;
  acceptanceCriteria: string;
  /** Authored planning estimate from the entity's `tokenomics` field, when present. */
  tokenomics?: Record<string, unknown>;
  /** Free-form appended prose (decisions, rationale, sign-offs), preserved verbatim. */
  notes?: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

export type BugSeverity = "blocker" | "critical" | "major" | "minor" | "trivial";

export interface Bug {
  id: string;
  campaignId: string | null;
  missionId: string | null;
  title: string;
  status: string;
  severity: BugSeverity;
  description: string;
  stepsToReproduce: string;
  expected: string;
  actual: string;
  rca: string;
  environment: string;
  /** Free-form appended prose (decisions, rationale, sign-offs), preserved verbatim. */
  notes?: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

/** A bug is parented by exactly one of a campaign or a mission. */
export type BugParent = { campaignId: string } | { missionId: string };

/** One node in a workflow: an agent to call, and how it is ordered against its siblings. */
export interface WorkflowStep {
  /** Unique within the workflow. Positional — regenerated wholesale by the extractor. */
  id: string;
  /** Agent / subagent type to call. Absent when the call named none: the default subagent. */
  agent?: string;
  /** Caption shown on the diagram node. */
  label: string;
  /** Node kind. Absent means "agent". */
  kind?: "agent" | "workflow" | "command";
  /** True when the call site sits inside a loop — drawn as ×N. */
  repeat?: boolean;
  /** Steps sharing a group id run concurrently. */
  parallel?: string;
  /** Step ids this step waits for. */
  dependsOn?: string[];
  /** Optional CLI backend override — claude | copilot | codex. */
  backend?: string;
}

/** A band of the workflow diagram. Mirrors an entry of the script's `meta.phases`. */
export interface WorkflowPhase {
  title: string;
  detail?: string;
  steps: WorkflowStep[];
}

/**
 * A workflow: the plan of execution for a campaign (which orchestrates its missions) or a
 * mission (which orchestrates its tasks). Backed by a folder holding `workflow.js` (plus an
 * append-only `runs.jsonl` log); the script's `meta` is the source of truth for name/description/phases.
 */
export interface Workflow {
  id: string;
  /** Exactly one of campaignId / missionId is non-null. */
  campaignId: string | null;
  missionId: string | null;
  name: string;
  description: string;
  phases: WorkflowPhase[];
  /** Repo-relative path of the script, e.g. `campaigns/a/workflows/w/workflow.js`. */
  scriptPath: string;
  folderPath: string;
  /** Repo-relative folder this workflow points at, or null when it owns its own script. */
  usesPath: string | null;
  /** Non-null when `meta` could not be located, evaluated or coerced. `phases` is then empty. */
  parseError: string | null;
  /** Status of the newest `## Runs` board line, or null when there are no runs. */
  lastRunStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A workflow is parented by exactly one of a campaign or a mission. */
export type WorkflowParent = { campaignId: string } | { missionId: string };

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
