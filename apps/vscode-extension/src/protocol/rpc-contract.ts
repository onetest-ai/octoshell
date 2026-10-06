// apps/vscode-extension/src/protocol/rpc-contract.ts
import { z } from "zod";
import type { Campaign, Mission, Task, Bug, TestCase, TestCaseStatus, MissionCoverage, TcBody, TcWritable, TcWriteRefusal } from "@octoshell/board";
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

/** One count per TC status, every key always present (so a panel can render a zero or omit it). */
export type TestStatusCounts = Record<TestCaseStatus, number>;

/**
 * One mission's row of the test summary: a `tests/m<n>/` folder and/or a board mission with an `M<n>` name token.
 * `missionId` is null for a tests folder no mission names; `total` is 0 for a mission with no TCs.
 */
export interface MissionTestSummary {
  missionId: string | null;
  /** `M<n>` token. */
  mission: string;
  /** `m<n>` folder name under `tests/`. */
  folder: string;
  title: string | null;
  missionStatus: string | null;
  total: number;
  counts: TestStatusCounts;
  /** Uncovered AC ids, in order. Always empty for a cancelled mission and for a folder with no mission. */
  uncovered: string[];
}

/** Test summary of one campaign (the campaign panel and the sidebar's Tests node). */
export interface TestSummary {
  campaignId: string;
  total: number;
  counts: TestStatusCounts;
  /** Sum of `uncovered.length` over the rows: cancelled missions excluded, a live mission with no tests folder counts all its ACs. */
  uncovered: number;
  /** By mission number; rows of a mission with no TCs are included (total 0). */
  missions: MissionTestSummary[];
}

/** One covered criterion of a TC: its id and the mission's text for it, `null` when the mission has no such criterion. */
export interface TestCaseCriterion {
  ac: string;
  text: string | null;
}

/**
 * Everything the test-case panel renders for one TC (`tests:get`). `mission` is null when no mission of the campaign
 * matches the TC's `m<n>` folder (the panel says `mission M<n> not found`); a cancelled mission still matches.
 * `evidence.exists` is true only for a regular file inside the workspace folder, i.e. one the evidence link can open.
 */
export interface TestCaseDetail {
  tc: TestCase;
  body: TcBody;
  campaignId: string | null;
  missionId: string | null;
  mission: { id: string; title: string; status: string } | null;
  criteria: TestCaseCriterion[];
  evidence: { path: string; exists: boolean } | null;
  /** The frontmatter parses but `kind` or `mission` is absent from it. */
  legacy: boolean;
  writable: TcWritable;
}

/**
 * `tests:setStatus`' answer. `stale`: the file's status or last run is not what the panel showed; nothing was
 * written and `current` is what the file holds. Any other refusal writes nothing too: `refused` is a path the guard
 * rejects, otherwise the writer's own reason (`symlink`, `unparseable`, `no-frontmatter`, `write-failed`, ...).
 */
export type SetTestStatusResult =
  | { ok: true; changed: boolean; tc: TestCase }
  | { ok: false; reason: "stale"; current: TestCase }
  | { ok: false; reason: "refused" | TcWriteRefusal; message: string };

/** A board id: non-empty and bounded, so a malformed call is rejected at the boundary. */
const ID = z.string().min(1).max(200);
/** The statuses a pick can record. `unknown` is what a file with no status lists as: never settable. A local enum, so protocol takes only types from @octoshell/board. */
const SETTABLE_TEST_STATUS = z.enum(["draft", "ready", "pass", "fail", "blocked"]);
/** A TC path, board-relative (TestCase.path); the host's guard decides whether it is one. */
const TEST_PATH = z.string().min(1).max(2000);
/** A mission's tests folder token: `m2`, `M2`, `3b`. Anything else is rejected, never turned into a path. */
const TEST_FOLDER = z.string().regex(/^[mM]?\d{1,4}[a-zA-Z]{0,3}$/);

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
    notes: z.string().optional(),
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
    notes: z.string().optional(),
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
    notes: z.string().optional(),
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
    notes: z.string().optional(),
  }),
  "bug:setStatus": z.object({ bugId: z.string(), status: z.string() }),
  "bug:delete": z.object({ bugId: z.string() }),
  "bug:sync": z.object({ campaignId: z.string().optional(), missionId: z.string().optional() }),
  // tests (M6): read-only views of the campaign's tests/m<n>/TC-*.md
  "tests:list": z.object({ campaignId: ID, mission: TEST_FOLDER.optional() }),
  "tests:coverage": z.object({ missionId: ID }),
  "tests:summary": z.object({ campaignId: ID }),
  // tests (0.1.1 T1.2): the panel's read and its status dropdown. The webview never sends file text: `base` is the
  // status and last run the panel showed, so the host can refuse (stale) when the file moved since.
  "tests:get": z.object({ path: TEST_PATH }),
  "tests:setStatus": z.object({
    path: TEST_PATH,
    status: SETTABLE_TEST_STATUS,
    base: z.object({
      status: z.enum(["draft", "ready", "pass", "fail", "blocked", "unknown"]),
      lastRun: z.object({ date: z.string().min(1).max(40), evidence: z.string().max(2000).optional() }).nullable(),
    }),
  }),
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
  /** `status` is set when the move was cancelled: the stored status the view should show. */
  "mission:setStatus": { ok: true; status?: string };
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
  /** The campaign's TCs (all missions, or the one named), by mission then file. Empty for an unknown campaign. */
  "tests:list": TestCase[];
  /** Which TCs cover each AC of the mission. `mission` is null (and `acs` empty) for an unknown mission or one with no `M<n>` token. */
  "tests:coverage": MissionCoverage;
  /** null for an unknown campaign. */
  "tests:summary": TestSummary | null;
  /** The TC's panel data; null for a path the guard rejects or a file that is gone. */
  "tests:get": TestCaseDetail | null;
  "tests:setStatus": SetTestStatusResult;
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
