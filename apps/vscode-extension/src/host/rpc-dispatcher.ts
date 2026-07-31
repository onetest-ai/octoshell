import type { BoardHost } from "./board-host.js";
import type { AppearanceStore } from "./appearance-store.js";
import { basename } from "node:path";
import { ClaudeTranscriptSource, rollup } from "@octoshell/tokenomics";
import { rpcArgs, type RpcMethod, type RpcArgsOf, type RpcResultOf } from "../protocol/index.js";

export interface DispatchCtx {
  /** Board façade — serves all board read/create/edit/delete features with no DB. */
  board: BoardHost;
  /** globalState-backed appearance preferences (no daemon/appRuntime needed). */
  appearanceStore: AppearanceStore;
  /** Workspace folder path (the open folder), used for project:list. */
  workspaceFolderPath: string;
  /** Host-backed dialogs (vscode.window.showOpenDialog). */
  dialog: { openFiles: () => Promise<string[]>; openFolder?: () => Promise<string | null> };
  /** Host editor capability — keeps this module free of a direct `vscode` import (testable). */
  editor: {
    openReadonly: (content: string, language?: string) => Promise<void>;
    openFile: (absPath: string) => Promise<void>;
  };
}

type RpcHandler<M extends RpcMethod> = (
  args: RpcArgsOf<M>,
  ctx: DispatchCtx,
) => RpcResultOf<M> | Promise<RpcResultOf<M>>;

export class RpcError extends Error {}

/** Surface a failed status write as an error so the UI shows it instead of silently reverting to draft. */
function okStatus(ok: boolean, status: string): { ok: true } {
  if (!ok) throw new RpcError(`Could not set status "${status}" (entity not found or unknown status).`);
  return { ok: true };
}

const handlers: { [M in RpcMethod]: RpcHandler<M> } = {
  "project:list": (_a, c) => [{ id: "workspace", name: basename(c.workspaceFolderPath) }],

  // Reads transcripts off disk and prices them. Deliberately computed on demand
  // rather than cached: the board and the transcripts both move underneath us,
  // and a stale cost number is worse than a slightly slow one.
  "tokenomics:report": (_a, c) =>
    rollup({
      repoRoot: c.workspaceFolderPath,
      artifactsRoot: c.board.artifactsRoot,
      board: c.board.boardModel,
      source: new ClaudeTranscriptSource(c.workspaceFolderPath),
    }),
  "project:open": (_a, _c) => ({ ok: true }),
  "dialog:openFiles": (_a, c) => c.dialog.openFiles(),
  "dialog:openFolder": (_a, c) => (c.dialog.openFolder ? c.dialog.openFolder() : null),
  "settings:getAppearance": (_a, c) => c.appearanceStore.get(),
  "settings:setAppearance": (a, c) => { c.appearanceStore.set(a.value as never); return { ok: true }; },
  "campaign:list": (_a, c) => c.board.listCampaigns(),
  "campaign:create": (a, c) => c.board.createCampaign({ name: a.name }),
  "campaign:get": (a, c) => ({ campaign: c.board.getCampaign(a.campaignId), summary: c.board.campaignSummary(a.campaignId) }),
  "campaign:update": (a, c) => { c.board.updateBrief("campaign", a.campaignId, { description: a.description, acceptanceCriteria: a.acceptanceCriteria, target: a.target, notes: a.notes }); return { ok: true }; },
  "campaign:setStatus": (a, c) => okStatus(c.board.setStatus("campaign", a.campaignId, a.status), a.status),
  "campaign:docs": (a, c) => c.board.campaignDocs(a.campaignId),
  "campaign:docs:createFile": (a, c) => ({ path: c.board.createCampaignDocFile(a.campaignId, a.name) }),
  "campaign:docs:addLink": (a, c) => c.board.addCampaignLink(a.campaignId, { url: a.url, title: a.title }),
  "campaign:docs:removeLink": (a, c) => { c.board.removeCampaignLink(a.campaignId, a.target); return { ok: true }; },
  "campaign:docs:addFile": (a, c) => c.board.addCampaignFile(a.campaignId, { path: a.path, label: a.label }),
  "campaign:delete": (a, c) => { c.board.deleteCampaign(a.campaignId); return { ok: true }; },
  "campaign:missions:sync": (a, c) => c.board.syncCampaignMissions(a.campaignId),
  "campaign:missions:create": (a, c) => c.board.createMissionsFromBoard(a.campaignId, a.missions),
  "mission:delete": (a, c) => { c.board.deleteMission(a.missionId); return { ok: true }; },
  "mission:list": (a, c) => c.board.listMissions(a.campaignId),
  "mission:get": (a, c) => c.board.getMission(a.missionId),
  "mission:update": (a, c) => { c.board.updateBrief("mission", a.missionId, { description: a.description, acceptanceCriteria: a.acceptanceCriteria, notes: a.notes }); return { ok: true }; },
  "mission:setStatus": (a, c) => okStatus(c.board.setStatus("mission", a.missionId, a.status), a.status),
  "mission:syncTasks": (a, c) => c.board.syncMissionFromBoard(a.missionId),
  "mission:docs": (a, c) => c.board.missionDocs(a.missionId),
  "mission:docs:addLink": (a, c) => c.board.addMissionLink(a.missionId, { url: a.url, title: a.title }),
  "mission:docs:removeLink": (a, c) => { c.board.removeMissionLink(a.missionId, a.target); return { ok: true }; },
  "mission:docs:addFile": (a, c) => c.board.addMissionFile(a.missionId, { path: a.path, label: a.label }),
  "task:get": (a, c) => c.board.getTask(a.taskId),
  "task:list": (a, c) => c.board.listTasks(a.missionId),
  "task:create": (a, c) => c.board.createTask({ missionId: a.missionId, name: a.name }),
  "task:update": (a, c) => { c.board.updateBrief("task", a.taskId, { description: a.description, acceptanceCriteria: a.acceptanceCriteria, notes: a.notes }); return { ok: true }; },
  "task:setStatus": (a, c) => okStatus(c.board.setStatus("task", a.taskId, a.status), a.status),
  "task:delete": (a, c) => { c.board.deleteTask(a.taskId); return { ok: true }; },
  "bug:get": (a, c) => c.board.getBug(a.bugId),
  "bug:list": (a, c) => c.board.listBugs(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId! }),
  "bug:create": (a, c) => c.board.createBug({ title: a.title, severity: a.severity, ...(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId! }) }),
  "bug:update": (a, c) => { c.board.updateBrief("bug", a.bugId, { name: a.title, severity: a.severity, description: a.description, stepsToReproduce: a.stepsToReproduce, expected: a.expected, actual: a.actual, rca: a.rca, environment: a.environment, notes: a.notes }); return { ok: true }; },
  "bug:setStatus": (a, c) => okStatus(c.board.setStatus("bug", a.bugId, a.status), a.status),
  "bug:delete": (a, c) => { c.board.deleteBug(a.bugId); return { ok: true }; },
  "bug:sync": (a, c) => c.board.syncBugsFromBoard(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId }),
  // workflows — the plan of execution; the script is run by Claude Code, never by the extension
  "workflow:list": (a, c) =>
    c.board.listWorkflows(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId! }),
  "workflow:get": (a, c) => c.board.getWorkflow(a.workflowId),
  "workflow:create": (a, c) =>
    c.board.createWorkflow(a.campaignId ? { campaignId: a.campaignId } : { missionId: a.missionId! }, { name: a.name }),
  "workflow:setMeta": (a, c) => { c.board.setWorkflowMeta(a.workflowId, a.meta); return { ok: true }; },
  "workflow:addRun": (a, c) => {
    c.board.appendWorkflowRun(a.workflowId, { status: a.status, summary: a.summary, at: a.at });
    return { ok: true };
  },
  "workflow:delete": (a, c) => { c.board.deleteWorkflow(a.workflowId); return { ok: true }; },
  "workflow:openScript": async (a, c) => {
    await c.editor.openFile(c.board.workflowScriptPath(a.workflowId));
    return { ok: true };
  },
};

/** Exported for the exhaustiveness test (Task 11). */
export const handlerMethods = Object.keys(handlers) as RpcMethod[];

export async function dispatch(method: string, rawArgs: unknown, ctx: DispatchCtx): Promise<unknown> {
  const handler = handlers[method as RpcMethod];
  if (!handler) throw new RpcError(`unknown method: ${method}`);
  const args = rpcArgs[method as RpcMethod].parse(rawArgs ?? {});
  return handler(args as never, ctx);
}
