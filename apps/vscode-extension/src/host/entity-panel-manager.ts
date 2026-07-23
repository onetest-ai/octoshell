import { basename, join } from "node:path";
import * as vscode from "vscode";
import { dispatch, type DispatchCtx } from "./rpc-dispatcher.js";
import { buildWebviewHtml } from "./webview-html.js";
import { routeUiMessage, type UiActions, type BindMessage } from "../protocol/index.js";

export const CAMPAIGN_VIEW_TYPE = "octoshell.campaign";
export const MISSION_VIEW_TYPE = "octoshell.mission";
export const TASK_VIEW_TYPE = "octoshell.task";
export const BUG_VIEW_TYPE = "octoshell.bug";
export const WORKFLOW_VIEW_TYPE = "octoshell.workflow";

type Kind = "campaign" | "mission" | "task" | "bug" | "workflow";

interface Rec {
  panel: vscode.WebviewPanel;
  kind: Kind;
  id: string;
  dispose: () => void;
}

/**
 * Opens one read-mostly webview tab per board entity (campaign/mission/task/bug).
 * Events are forwarded filtered to the entity: campaign by campaignId, mission by missionId.
 */
export class EntityPanelManager {
  private readonly records = new Map<string, Rec>(); // key: `${kind}:${id}`
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ctx: DispatchCtx,
  ) {}

  openCampaign(id: string): void {
    this.open("campaign", id, CAMPAIGN_VIEW_TYPE, this.campaignTitle(id));
  }
  openMission(id: string): void {
    this.open("mission", id, MISSION_VIEW_TYPE, this.missionTitle(id));
  }
  openTask(id: string): void {
    this.open("task", id, TASK_VIEW_TYPE, this.taskTitle(id));
  }
  openBug(id: string): void {
    this.open("bug", id, BUG_VIEW_TYPE, this.bugTitle(id));
  }
  openWorkflow(id: string): void {
    this.open("workflow", id, WORKFLOW_VIEW_TYPE, this.workflowTitle(id));
  }

  /** Dispose the entity's details panel if open (used after delete). */
  closeEntity(kind: Kind, id: string): void {
    this.records.get(`${kind}:${id}`)?.panel.dispose();
  }

  /** Public: nudge an open campaign panel to reload (used by host commands outside this class). */
  refreshCampaign(campaignId: string): void {
    this.refreshEntity("campaign", campaignId);
  }

  /** Public: nudge an open mission panel to reload (used by host commands outside this class). */
  refreshMission(missionId: string): void {
    this.refreshEntity("mission", missionId);
  }

  /** Public: nudge an open task panel to reload (used by host commands outside this class). */
  refreshTask(taskId: string): void {
    this.refreshEntity("task", taskId);
  }

  /** Public: nudge an open bug panel to reload (used by host commands outside this class). */
  refreshBug(bugId: string): void {
    this.refreshEntity("bug", bugId);
  }

  /** Public: nudge an open workflow panel to reload (used by host commands outside this class). */
  refreshWorkflow(workflowId: string): void {
    this.refreshEntity("workflow", workflowId);
  }

  /** Used by the WebviewPanelSerializer to rebind a restored panel. */
  adopt(panel: vscode.WebviewPanel, kind: Kind, id: string): void {
    const mediaPath = join(this.context.extensionPath, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(mediaPath)] };
    this.wire(panel, kind, id);
  }

  private campaignTitle(id: string): string {
    return this.ctx.board.getCampaign(id)?.name ?? "Campaign";
  }
  private missionTitle(id: string): string {
    return this.ctx.board.getMission(id)?.title ?? "Mission";
  }
  private taskTitle(id: string): string {
    return this.ctx.board.getTask(id)?.name ?? "Task";
  }
  private bugTitle(id: string): string {
    return this.ctx.board.getBug(id)?.title ?? "Bug";
  }
  private workflowTitle(id: string): string {
    return this.ctx.board.getWorkflow(id)?.name ?? "Workflow";
  }

  private async newMissionInCampaign(campaignId: string): Promise<void> {
    const intent = await vscode.window.showInputBox({ prompt: "Mission intent", placeHolder: "Describe the mission…" });
    if (!intent) return;
    try {
      const res = (await dispatch("campaign:submit", { campaignId, intent }, this.ctx)) as { missionId: string };
      this.openMission(res.missionId);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not start mission — ${(err as Error).message}`);
    }
  }

  private async newTaskInMission(missionId: string): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: "Task name", placeHolder: "Describe the task…" });
    if (!name) return;
    try {
      const task = (await dispatch("task:create", { missionId, name }, this.ctx)) as { id: string };
      this.openTask(task.id);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not create task — ${(err as Error).message}`);
    }
  }

  private async newBugInCampaign(campaignId: string): Promise<void> {
    const title = await vscode.window.showInputBox({ prompt: "Bug title", placeHolder: "Describe the faulty behaviour…" });
    if (!title) return;
    try {
      const bug = (await dispatch("bug:create", { title, campaignId }, this.ctx)) as { id: string };
      this.refreshEntity("campaign", campaignId);
      this.openBug(bug.id);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not create bug — ${(err as Error).message}`);
    }
  }

  private async newBugInMission(missionId: string): Promise<void> {
    const title = await vscode.window.showInputBox({ prompt: "Bug title", placeHolder: "Describe the faulty behaviour…" });
    if (!title) return;
    try {
      const bug = (await dispatch("bug:create", { title, missionId }, this.ctx)) as { id: string };
      this.refreshEntity("mission", missionId);
      this.openBug(bug.id);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not create bug — ${(err as Error).message}`);
    }
  }

  private async openCampaignDoc(campaignId: string, relPath: string): Promise<void> {
    try {
      const abs = this.ctx.board.campaignDocPath(campaignId, relPath);
      await vscode.window.showTextDocument(vscode.Uri.file(abs));
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not open document — ${(err as Error).message}`);
    }
  }

  private async addCampaignLink(campaignId: string): Promise<void> {
    const url = await vscode.window.showInputBox({ prompt: "Document URL", placeHolder: "https://…" });
    if (!url) return;
    const title = await vscode.window.showInputBox({ prompt: "Title (optional)" });
    try {
      await dispatch("campaign:docs:addLink", { campaignId, url, title }, this.ctx);
      this.refreshEntity("campaign", campaignId);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not attach link — ${(err as Error).message}`);
    }
  }

  private async attachCampaignFile(campaignId: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picks = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: ws, openLabel: "Attach" });
    const file = picks?.[0];
    if (!file) return;
    try {
      await dispatch("campaign:docs:addFile", { campaignId, path: file.fsPath, label: basename(file.fsPath) }, this.ctx);
      this.refreshEntity("campaign", campaignId);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not attach file — ${(err as Error).message}`);
    }
  }

  /** Nudge an open campaign/mission/task panel to reload by replaying a scoped spine event. */
  private refreshEntity(kind: Kind, id: string): void {
    const rec = this.records.get(`${kind}:${id}`);
    if (!rec) return;
    const payload =
      kind === "campaign"
        ? { projectId: "workspace", campaignId: id }
        : kind === "mission"
          ? { projectId: "workspace", missionId: id }
          : kind === "task"
            ? { projectId: "workspace", taskId: id }
            : kind === "bug"
              ? { projectId: "workspace", bugId: id }
              : { projectId: "workspace", workflowId: id };
    void rec.panel.webview.postMessage({ type: "spine:event", payload });
  }

  private async openMissionDoc(missionId: string, relPath: string): Promise<void> {
    try {
      const abs = this.ctx.board.missionDocPath(missionId, relPath);
      await vscode.window.showTextDocument(vscode.Uri.file(abs));
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not open document — ${(err as Error).message}`);
    }
  }

  private async addMissionLink(missionId: string): Promise<void> {
    const url = await vscode.window.showInputBox({ prompt: "Document URL", placeHolder: "https://…" });
    if (!url) return;
    const title = await vscode.window.showInputBox({ prompt: "Title (optional)" });
    try {
      await dispatch("mission:docs:addLink", { missionId, url, title }, this.ctx);
      this.refreshEntity("mission", missionId);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not attach link — ${(err as Error).message}`);
    }
  }

  private async attachMissionFile(missionId: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    const picks = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: ws, openLabel: "Attach" });
    const file = picks?.[0];
    if (!file) return;
    try {
      await dispatch("mission:docs:addFile", { missionId, path: file.fsPath, label: basename(file.fsPath) }, this.ctx);
      this.refreshEntity("mission", missionId);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not attach file — ${(err as Error).message}`);
    }
  }

  private async confirmDeleteMission(missionId: string, campaignIdToRefresh?: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      "Delete this mission? This permanently removes the mission and its tasks.",
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") return;
    try {
      await dispatch("mission:delete", { missionId }, this.ctx);
      this.records.get(`mission:${missionId}`)?.panel.dispose(); // close the mission's own panel if open
      if (campaignIdToRefresh) this.refreshEntity("campaign", campaignIdToRefresh);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not delete mission — ${(err as Error).message}`);
    }
  }

  private async confirmDeleteTask(taskId: string, missionIdToRefresh?: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      "Delete this task? This permanently removes the task.",
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") return;
    try {
      await dispatch("task:delete", { taskId }, this.ctx);
      this.records.get(`task:${taskId}`)?.panel.dispose();
      if (missionIdToRefresh) this.refreshEntity("mission", missionIdToRefresh);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not delete task — ${(err as Error).message}`);
    }
  }

  private async confirmDeleteBug(bugId: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      "Delete this bug? This permanently removes the bug.",
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") return;
    const bug = this.ctx.board.getBug(bugId);
    try {
      await dispatch("bug:delete", { bugId }, this.ctx);
      this.records.get(`bug:${bugId}`)?.panel.dispose();
      if (bug?.campaignId) this.refreshEntity("campaign", bug.campaignId);
      else if (bug?.missionId) this.refreshEntity("mission", bug.missionId);
    } catch (err) {
      vscode.window.showErrorMessage(`Octobots: could not delete bug — ${(err as Error).message}`);
    }
  }

  private open(kind: Kind, id: string, viewType: string, title: string): void {
    const key = `${kind}:${id}`;
    const existing = this.records.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const mediaPath = join(this.context.extensionPath, "media");
    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(mediaPath)],
    });
    this.wire(panel, kind, id);
  }

  private wire(panel: vscode.WebviewPanel, kind: Kind, id: string): void {
    const mediaPath = join(this.context.extensionPath, "media");
    panel.webview.html = buildWebviewHtml(panel.webview, mediaPath);
    const key = `${kind}:${id}`;
    const rec: Rec = { panel, kind, id, dispose: () => {} };
    this.records.set(key, rec);

    // board.on("entities:changed") fires with NO payload — disk is authoritative, so we refresh
    // the whole open panel (replaying a scoped spine event) on any board change.
    const handler = (): void => { this.refreshEntity(kind, id); };
    this.ctx.board.on("entities:changed", handler);
    const off = (): void => { this.ctx.board.off("entities:changed", handler); };

    const actions: UiActions = {
      openMission: (m) => this.openMission(m.id),
      openTask: (m) => this.openTask(m.id),
      newMissionInCampaign: (m) => void this.newMissionInCampaign(m.id),
      newTaskInMission: (m) => void this.newTaskInMission(m.id),
      openCampaignDoc: (m) => void this.openCampaignDoc(m.campaignId, m.relPath),
      openMissionDoc: (m) => void this.openMissionDoc(m.missionId, m.relPath),
      addCampaignLink: (m) => void this.addCampaignLink(m.campaignId),
      addMissionLink: (m) => void this.addMissionLink(m.missionId),
      attachCampaignFile: (m) => void this.attachCampaignFile(m.campaignId),
      attachMissionFile: (m) => void this.attachMissionFile(m.missionId),
      deleteMission: (m) => void this.confirmDeleteMission(m.missionId, kind === "campaign" ? id : undefined),
      deleteTask: (m) => void this.confirmDeleteTask(m.taskId, kind === "mission" ? id : undefined),
      openBug: (m) => this.openBug(m.id),
      newBugInCampaign: (m) => void this.newBugInCampaign(m.id),
      newBugInMission: (m) => void this.newBugInMission(m.id),
      deleteBug: (m) => void this.confirmDeleteBug(m.bugId),
      openFile: (m) => void vscode.window.showTextDocument(vscode.Uri.file(m.path)),
    };

    const sub = panel.webview.onDidReceiveMessage(
      async (msg: { type?: string; id?: number; method?: string; args?: Record<string, unknown> }) => {
        if (msg?.type === "webview-ready") {
          void panel.webview.postMessage({ type: "bind" as const, kind, id } satisfies BindMessage);
          return;
        }
        if (routeUiMessage(msg, actions)) return;
        if (msg?.type !== "rpc" || typeof msg.id !== "number" || !msg.method) return;
        try {
          const value = await dispatch(msg.method, msg.args ?? {}, this.ctx);
          void panel.webview.postMessage({ type: "rpc:result", id: msg.id, ok: true, value });
        } catch (err) {
          void panel.webview.postMessage({ type: "rpc:result", id: msg.id, ok: false, error: (err as Error).message });
        }
      },
    );

    rec.dispose = () => { off(); sub.dispose(); };
    panel.onDidDispose(() => {
      rec.dispose();
      this.records.delete(key);
    });
  }
}
