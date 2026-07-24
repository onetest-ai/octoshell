// apps/vscode-extension/src/protocol/rpc-contract.ts
import { z } from "zod";
import type { Campaign, Mission, Task, Bug, Workflow } from "@octoshell/board";
import type { Appearance } from "../host/appearance-store.js";
import type { Report as TokenomicsReport } from "@octoshell/tokenomics";

/** Disk-synthesised doc link or attached file — returned by the board-backed doc routes. */
export interface DocLink {
  id: string;
  kind: "link" | "file";
  target: string;
  label: string;
  createdAt: number;
}

/** On-disk file entry in a campaign/mission folder. */
export interface DocFile {
  name: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

/** Docs payload returned by campaign:docs and mission:docs. */
export interface DocsResult {
  files: DocFile[];
  links: DocLink[];
  attachedFiles: DocLink[];
}

/**
 * A board-line mission proposal — a `## Missions` bullet that may or may not have a folder yet.
 * Returned by campaign:missions:sync so the UI can show what can be created.
 */
export interface MissionProposal {
  title: string;
  description: string;
  exists: boolean;
}

/**
 * Campaign summary returned by campaign:get — board-backed, no DB.
 * Matches the daemon's CampaignSummary shape exactly so the webview can treat both identically.
 */
export interface CampaignSummary {
  campaignId: string;
  name: string;
  isDefault: boolean;
  /** Per-exact-status counts (e.g. "executing", "awaitingApproval", "done", "draft", "failed", "cancelled"). */
  counts: Record<string, number>;
  rollupStatus: "draft" | "active" | "failed" | "completed" | "cancelled";
  total: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  draft: number;
}

// ── Argument schemas (validated at the host boundary). projectId omitted unless the
//    handler actually reads it (project:open). Unknown keys (e.g. an injected projectId)
//    are stripped by z.object by default and harmlessly ignored. ──
export const rpcArgs = {
  // project / appRuntime
  "project:list": z.object({}),
  "project:open": z.object({ projectId: z.string() }),
  // dialogs
  "dialog:openFiles": z.object({}),
  "dialog:openFolder": z.object({}),
  // settings (minimal: appearance backed; providers/permissions canned)
  "settings:getAppearance": z.object({}),
  "settings:setAppearance": z.object({ value: z.unknown() }),

  "tokenomics:report": z.object({}),
  // campaigns
  "campaign:list": z.object({}),
  "campaign:create": z.object({ name: z.string() }),
  "campaign:get": z.object({ campaignId: z.string() }),
  "campaign:update": z.object({
    campaignId: z.string(),
    description: z.string().optional(), acceptanceCriteria: z.string().optional(), target: z.string().optional(),
  }),
  "campaign:setStatus": z.object({ campaignId: z.string(), status: z.string() }),
  "campaign:docs": z.object({ campaignId: z.string() }),
  "campaign:docs:createFile": z.object({ campaignId: z.string(), name: z.string() }),
  "campaign:docs:addLink": z.object({ campaignId: z.string(), url: z.string(), title: z.string().optional() }),
  "campaign:docs:removeLink": z.object({ campaignId: z.string(), target: z.string() }),
  "campaign:docs:addFile": z.object({ campaignId: z.string(), path: z.string(), label: z.string().optional() }),
  "campaign:delete": z.object({ campaignId: z.string() }),
  "campaign:missions:sync": z.object({ campaignId: z.string() }),
  "campaign:missions:create": z.object({
    campaignId: z.string(),
    missions: z.array(z.object({ title: z.string(), description: z.string().optional() })),
  }),
  // missions
  "mission:delete": z.object({ missionId: z.string() }),
  "mission:list": z.object({ campaignId: z.string() }),
  "mission:get": z.object({ missionId: z.string() }),
  "mission:update": z.object({
    missionId: z.string(), description: z.string().optional(), acceptanceCriteria: z.string().optional(),
  }),
  "mission:setStatus": z.object({ missionId: z.string(), status: z.string() }),
  "mission:syncTasks": z.object({ missionId: z.string() }),
  "mission:docs": z.object({ missionId: z.string() }),
  "mission:docs:addLink": z.object({ missionId: z.string(), url: z.string(), title: z.string().optional() }),
  "mission:docs:removeLink": z.object({ missionId: z.string(), target: z.string() }),
  "mission:docs:addFile": z.object({ missionId: z.string(), path: z.string(), label: z.string().optional() }),
  // tasks
  "task:get": z.object({ taskId: z.string() }),
  "task:list": z.object({ missionId: z.string() }),
  "task:create": z.object({ missionId: z.string(), name: z.string() }),
  "task:update": z.object({
    taskId: z.string(), description: z.string().optional(), acceptanceCriteria: z.string().optional(),
  }),
  "task:setStatus": z.object({ taskId: z.string(), status: z.string() }),
  "task:delete": z.object({ taskId: z.string() }),
  // bugs
  "bug:get": z.object({ bugId: z.string() }),
  "bug:list": z.object({ campaignId: z.string().optional(), missionId: z.string().optional() }),
  "bug:create": z.object({
    title: z.string(),
    severity: z.enum(["blocker", "critical", "major", "minor", "trivial"]).optional(),
    campaignId: z.string().optional(), missionId: z.string().optional(),
  }),
  "bug:update": z.object({
    bugId: z.string(),
    title: z.string().optional(),
    severity: z.enum(["blocker", "critical", "major", "minor", "trivial"]).optional(),
    description: z.string().optional(), stepsToReproduce: z.string().optional(),
    expected: z.string().optional(), actual: z.string().optional(),
    rca: z.string().optional(), environment: z.string().optional(),
  }),
  "bug:setStatus": z.object({ bugId: z.string(), status: z.string() }),
  "bug:delete": z.object({ bugId: z.string() }),
  "bug:sync": z.object({ campaignId: z.string().optional(), missionId: z.string().optional() }),
  // workflows
  "workflow:list": z.object({ campaignId: z.string().optional(), missionId: z.string().optional() }),
  "workflow:get": z.object({ workflowId: z.string() }),
  "workflow:create": z.object({
    name: z.string(),
    campaignId: z.string().optional(),
    missionId: z.string().optional(),
  }),
  "workflow:setMeta": z.object({
    workflowId: z.string(),
    meta: z.object({
      name: z.string(),
      description: z.string(),
      phases: z.array(z.object({
        title: z.string(),
        detail: z.string().optional(),
        steps: z.array(z.object({
          id: z.string(),
          agent: z.string(),
          label: z.string(),
          parallel: z.string().optional(),
          dependsOn: z.array(z.string()).optional(),
          backend: z.string().optional(),
        })),
      })),
    }),
  }),
  "workflow:addRun": z.object({
    workflowId: z.string(),
    status: z.string(),
    summary: z.string(),
    at: z.string(),
  }),
  "workflow:delete": z.object({ workflowId: z.string() }),
  "workflow:openScript": z.object({ workflowId: z.string() }),
} satisfies Record<string, z.ZodType>;

/** A single project entry returned by project:list (workspace = the open folder). */
export interface ProjectRecord {
  id: string;
  name: string;
}

// ── Result types (compile-time only; sourced from our own daemon) ──
export interface RpcResults {
  "project:list": ProjectRecord[];

  /** Measured cost/effort per mission and task, collected from agent transcripts. */
  "tokenomics:report": TokenomicsReport;
  "project:open": { ok: true };
  "dialog:openFiles": string[];
  "dialog:openFolder": string | null;
  "settings:getAppearance": Appearance;
  "settings:setAppearance": { ok: true };
  "campaign:list": Campaign[];
  "campaign:create": Campaign;
  "campaign:get": { campaign: Campaign | null; summary: CampaignSummary | null };
  "campaign:update": { ok: true };
  "campaign:setStatus": { ok: true };
  "campaign:docs": DocsResult;
  "campaign:docs:createFile": { path: string };
  "campaign:docs:addLink": DocLink;
  "campaign:docs:removeLink": { ok: true };
  "campaign:docs:addFile": DocLink;
  "campaign:delete": { ok: true };
  "campaign:missions:sync": { proposals: MissionProposal[] };
  "campaign:missions:create": { created: number };
  "mission:delete": { ok: true };
  "mission:list": Mission[];
  "mission:get": Mission | null;
  "mission:update": { ok: true };
  "mission:setStatus": { ok: true };
  "mission:syncTasks": { created: number };
  "mission:docs": DocsResult;
  "mission:docs:addLink": DocLink;
  "mission:docs:removeLink": { ok: true };
  "mission:docs:addFile": DocLink;
  "task:get": Task | null;
  "task:list": Task[];
  "task:create": Task;
  "task:update": { ok: true };
  "task:setStatus": { ok: true };
  "task:delete": { ok: true };
  "bug:get": Bug | null;
  "bug:list": Bug[];
  "bug:create": Bug;
  "bug:update": { ok: true };
  "bug:setStatus": { ok: true };
  "bug:delete": { ok: true };
  "bug:sync": { created: number };
  // workflows — the plan of execution; the script is run by Claude Code, never by the extension
  "workflow:list": Workflow[];
  "workflow:get": Workflow | null;
  "workflow:create": { id: string; folderPath: string };
  "workflow:setMeta": { ok: true };
  "workflow:addRun": { ok: true };
  "workflow:delete": { ok: true };
  "workflow:openScript": { ok: true };
}

export type RpcMethod = keyof typeof rpcArgs & keyof RpcResults;
export type RpcArgsOf<M extends keyof typeof rpcArgs> = z.infer<(typeof rpcArgs)[M]>;
export type RpcResultOf<M extends keyof RpcResults> = RpcResults[M];

// Compile-time drift guard: the two key sets must be identical. If a method is added to one
// but not the other, one of these conditional types resolves to `never` and assigning `true`
// fails to compile.
type ArgKeys = keyof typeof rpcArgs;
type ResKeys = keyof RpcResults;
type _ArgsSubsetOfResults = [ArgKeys] extends [ResKeys] ? true : never;
type _ResultsSubsetOfArgs = [ResKeys] extends [ArgKeys] ? true : never;
const _assertArgsSubset: _ArgsSubsetOfResults = true;
const _assertResultsSubset: _ResultsSubsetOfArgs = true;
void _assertArgsSubset;
void _assertResultsSubset;
