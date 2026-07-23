import { join, basename } from "node:path";
import * as vscode from "vscode";
import { BoardHost } from "./host/board-host.js";
import { AppearanceStore } from "./host/appearance-store.js";
import { EntityPanelManager, CAMPAIGN_VIEW_TYPE, MISSION_VIEW_TYPE, TASK_VIEW_TYPE, BUG_VIEW_TYPE, WORKFLOW_VIEW_TYPE } from "./host/entity-panel-manager.js";
import { TokenomicsPanel } from "./host/tokenomics-panel.js";
import { renderReportHtml, type Report as TokenomicsReport } from "@octoshell/tokenomics";
import { CampaignsTree } from "./host/campaigns-tree.js";
import { dispatch, type DispatchCtx } from "./host/rpc-dispatcher.js";
import { registerBoardWatcher } from "./host/board-watcher.js";
import { packStatus, installPack } from "./host/octobots-skill.js";
import { fetchBundleCatalog, bundleInstallCommand } from "./host/sdlc-bundles.js";

// Explicit-only install of the bundled octobots pack (skill + planning agents) into <workspace>/.claude.
function installOctobotsPack(context: vscode.ExtensionContext, repoRoot: string): void {
  const src = vscode.Uri.joinPath(context.extensionUri, "resources", "octobots-pack").fsPath;
  const res = installPack(src, repoRoot);
  void vscode.window.showInformationMessage(`Octobots: workflow pack installed (${res.written} files).`);
}

/**
 * Thin launcher for the sdlc-skills team-bundle installer. Picks a bundle (from the hybrid catalog)
 * and opens an integrated terminal running the installer, which owns the guided, interactive flow —
 * Octobots never captures output or verifies the result. `update` appends `--update`.
 */
async function launchSdlcBundleInstall(repoRoot: string | undefined, update: boolean): Promise<void> {
  if (!repoRoot) {
    void vscode.window.showErrorMessage("Octobots: open a workspace folder first.");
    return;
  }
  const bundles = await fetchBundleCatalog();
  const pick = await vscode.window.showQuickPick(
    bundles.map((b) => ({ label: b.label, description: b.id, detail: b.description, id: b.id })),
    { placeHolder: update ? "Update which SDLC team bundle?" : "Install which SDLC team bundle?" },
  );
  if (!pick) return;
  const terminal = vscode.window.createTerminal({ cwd: repoRoot, name: "SDLC Bundle Install" });
  terminal.sendText(bundleInstallCommand(pick.id, { update }));
  terminal.show();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("Octobots: open a folder to get started.");
    return;
  }
  const fsPath = folder.uri.fsPath;

  const repoRoot = folder.uri.fsPath;

  context.subscriptions.push(
    vscode.commands.registerCommand("octoshell.installOctobotsWorkflowSkill", () => {
      installOctobotsPack(context, repoRoot);
    }),
    vscode.commands.registerCommand("octoshell.installSdlcBundle", () =>
      launchSdlcBundleInstall(repoRoot, false),
    ),
    vscode.commands.registerCommand("octoshell.updateSdlcBundle", () =>
      launchSdlcBundleInstall(repoRoot, true),
    ),
  );

  // Explicit-only: on open, if the pack (skill + planning agents) is missing/outdated, PROMPT —
  // never write without the user's click. Shown at most once per activation.
  void (async () => {
    const st = packStatus(repoRoot);
    if (st.installed && st.upToDate) return;
    const verb = st.installed ? "update" : "install";
    const Verb = `${verb[0]!.toUpperCase()}${verb.slice(1)}`;
    const choice = await vscode.window.showInformationMessage(
      `Octobots workflow pack isn't ${st.installed ? "up to date" : "installed"} for this repo. ${Verb} it so planning agents understand campaigns/missions/tasks?`,
      "Install",
      "Not now",
    );
    if (choice === "Install") installOctobotsPack(context, repoRoot);
  })();

  const board = new BoardHost(join(fsPath, ".octobots"));
  board.reconcile(); // initial load: stamps missing task/bug id-markers and emits entities:changed
  const appearanceStore = new AppearanceStore(context.globalState);
  const dispatchCtx: DispatchCtx = {
    board,
    appearanceStore,
    workspaceFolderPath: fsPath,
    dialog: {
      openFiles: async () => {
        const picks = await vscode.window.showOpenDialog({ canSelectMany: true });
        return picks?.map((u) => u.fsPath) ?? [];
      },
      openFolder: async () => {
        const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
        return picks?.[0]?.fsPath ?? null;
      },
    },
    editor: {
      openReadonly: async (content: string, language?: string) => {
        const doc = await vscode.workspace.openTextDocument({ content, language: language ?? "log" });
        await vscode.window.showTextDocument(doc, { preview: true });
      },
      openFile: async (absPath: string) => {
        await vscode.window.showTextDocument(vscode.Uri.file(absPath));
      },
    },
  };
  const entityPanels = new EntityPanelManager(context, dispatchCtx);
  const tokenomicsPanel = new TokenomicsPanel(context, dispatchCtx);

  // Disk is the single source of truth. One debounced, git-quiescence-gated watcher over the whole
  // `.octobots` board tree does ONE disk re-parse after the tree settles — handling every
  // create/edit/delete (including bulk git checkout/stash/pop/rebase) without per-file reactive sync
  // that could churn state against a half-torn mid-operation tree.
  context.subscriptions.push(
    registerBoardWatcher({
      folder,
      board,
      repoRoot: folder.uri.fsPath,
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(CAMPAIGN_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const id = (state as { id?: string } | undefined)?.id;
        if (id) entityPanels.adopt(panel, "campaign", id);
        else panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer(MISSION_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const id = (state as { id?: string } | undefined)?.id;
        if (id) entityPanels.adopt(panel, "mission", id);
        else panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer(TASK_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const id = (state as { id?: string } | undefined)?.id;
        if (id) entityPanels.adopt(panel, "task", id);
        else panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer(BUG_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const id = (state as { id?: string } | undefined)?.id;
        if (id) entityPanels.adopt(panel, "bug", id);
        else panel.dispose();
      },
    }),
    vscode.window.registerWebviewPanelSerializer(WORKFLOW_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const id = (state as { id?: string } | undefined)?.id;
        if (id) entityPanels.adopt(panel, "workflow", id);
        else panel.dispose();
      },
    }),
  );

  const campaignsTree = new CampaignsTree(board);
  // Refresh the campaigns tree when the board changes on disk. The only disk watcher stays
  // scoped to `.octobots/`.
  const boardRefreshHandler = (): void => {
    campaignsTree.refresh();
  };
  board.on("entities:changed", boardRefreshHandler);
  context.subscriptions.push({ dispose: () => board.off("entities:changed", boardRefreshHandler) });

  const campaignsView = vscode.window.createTreeView("octoshell.campaigns", { treeDataProvider: campaignsTree });
  campaignsView.onDidChangeVisibility((e) => {
    if (e.visible) { board.reconcile(); campaignsTree.refresh(); }
  });

  context.subscriptions.push(
    campaignsView,
    vscode.commands.registerCommand("octoshell.openTokenomics", () => tokenomicsPanel.open()),
    vscode.commands.registerCommand("octoshell.exportTokenomicsReport", async () => {
      // The export is the artefact a cost submission attaches, so it is written
      // where the user chooses rather than buried in the workspace.
      const report = (await dispatch("tokenomics:report", {}, dispatchCtx)) as TokenomicsReport;
      if (report.runs.length === 0) {
        void vscode.window.showWarningMessage(
          "Octobots: nothing measured yet — no missions have attributable agent transcripts.",
        );
        return;
      }
      const target = await vscode.window.showSaveDialog({
        title: "Export tokenomics report",
        defaultUri: vscode.Uri.file(join(fsPath, "tokenomics-report.html")),
        filters: { HTML: ["html"] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(renderReportHtml(report), "utf8"));
      const open = await vscode.window.showInformationMessage(
        `Octobots: wrote ${report.runs.length} missions to ${basename(target.fsPath)}.`,
        "Open",
      );
      if (open === "Open") await vscode.env.openExternal(target);
    }),
    vscode.commands.registerCommand("octoshell.refreshCampaigns", () => {
      board.reconcile();
      campaignsTree.refresh();
    }),
    // Clicking a tree item opens only the entity panel.
    vscode.commands.registerCommand("octoshell.openCampaignById", (id: string) => entityPanels.openCampaign(id)),
    vscode.commands.registerCommand("octoshell.openMissionById", (id: string) => entityPanels.openMission(id)),
    vscode.commands.registerCommand("octoshell.openTaskById", (id: string) => entityPanels.openTask(id)),
    vscode.commands.registerCommand("octoshell.openBugById", (id: string) => entityPanels.openBug(id)),
    vscode.commands.registerCommand("octoshell.openWorkflowById", (id: string) => entityPanels.openWorkflow(id)),
    vscode.commands.registerCommand("octoshell.newCampaign", async () => {
      const name = await vscode.window.showInputBox({ prompt: "Campaign name", placeHolder: "e.g. Q3 Rollout" });
      if (!name) return;
      try {
        const campaign = (await dispatch("campaign:create", { name }, dispatchCtx)) as { id: string };
        campaignsTree.refresh();
        entityPanels.openCampaign(campaign.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not create campaign — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.newMissionInCampaign", async (node?: { campaign?: { id: string } }) => {
      const campaignId = node?.campaign?.id;
      if (!campaignId) return;
      const title = await vscode.window.showInputBox({ prompt: "Mission title", placeHolder: "e.g. Implement login flow" });
      if (!title) return;
      try {
        await dispatch("campaign:missions:create", { campaignId, missions: [{ title, description: "" }] }, dispatchCtx);
        campaignsTree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not create mission — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.deleteCampaign", async (node?: { campaign?: { id: string; name: string } }) => {
      const c = node?.campaign;
      if (!c) return;
      const pick = await vscode.window.showWarningMessage(
        `Delete campaign "${c.name}" and its missions? This cannot be undone.`,
        { modal: true }, "Delete",
      );
      if (pick !== "Delete") return;
      try {
        await dispatch("campaign:delete", { campaignId: c.id }, dispatchCtx);
        entityPanels.closeEntity("campaign", c.id);
        campaignsTree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not delete campaign — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.deleteMission", async (node?: { mission?: { id: string; title: string } }) => {
      const m = node?.mission;
      if (!m) return;
      const pick = await vscode.window.showWarningMessage(
        `Delete mission "${m.title}"? This cannot be undone.`,
        { modal: true }, "Delete",
      );
      if (pick !== "Delete") return;
      try {
        await dispatch("mission:delete", { missionId: m.id }, dispatchCtx);
        entityPanels.closeEntity("mission", m.id);
        campaignsTree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not delete mission — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.deleteTask", async (node?: { task?: { id: string; name: string } }) => {
      const t = node?.task;
      if (!t) return;
      const pick = await vscode.window.showWarningMessage(
        `Delete task "${t.name}"? This cannot be undone.`,
        { modal: true }, "Delete",
      );
      if (pick !== "Delete") return;
      try {
        await dispatch("task:delete", { taskId: t.id }, dispatchCtx);
        entityPanels.closeEntity("task", t.id);
        campaignsTree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not delete task — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.deleteBug", async (node?: { bug?: { id: string; title: string } }) => {
      const b = node?.bug;
      if (!b) return;
      const pick = await vscode.window.showWarningMessage(
        `Delete bug "${b.title}"? This cannot be undone.`,
        { modal: true }, "Delete",
      );
      if (pick !== "Delete") return;
      try {
        await dispatch("bug:delete", { bugId: b.id }, dispatchCtx);
        entityPanels.closeEntity("bug", b.id);
        campaignsTree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not delete bug — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.newWorkflow", async (node?: { campaign?: { id: string }; mission?: { id: string } }) => {
      const parent = node?.campaign ? { campaignId: node.campaign.id } : node?.mission ? { missionId: node.mission.id } : null;
      if (!parent) return;
      const name = await vscode.window.showInputBox({
        prompt: "Workflow name",
        placeHolder: "e.g. build-tasks",
      });
      if (!name) return;
      try {
        const wf = board.createWorkflow(parent, { name });
        campaignsTree.refresh();
        entityPanels.openWorkflow(wf.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not create workflow — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.deleteWorkflow", async (node?: { workflow?: { id: string; name: string } }) => {
      const wf = node?.workflow;
      if (!wf) return;
      const pick = await vscode.window.showWarningMessage(
        `Delete the workflow "${wf.name}"? This permanently removes its workflow.md and workflow.js.`,
        { modal: true }, "Delete",
      );
      if (pick !== "Delete") return;
      try {
        board.deleteWorkflow(wf.id);
        entityPanels.closeEntity("workflow", wf.id);
        campaignsTree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not delete workflow — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("octoshell.addFileToCampaign", async (uri?: vscode.Uri) => {
      if (!uri) return;
      const campaigns = board.listCampaigns();
      if (campaigns.length === 0) {
        vscode.window.showInformationMessage("Octobots: create a campaign first.");
        return;
      }
      let campaignId = campaigns[0]!.id;
      if (campaigns.length > 1) {
        const pick = await vscode.window.showQuickPick(
          campaigns.map((c) => ({ label: c.name, id: c.id })),
          { placeHolder: "Add file to which campaign?" },
        );
        if (!pick) return;
        campaignId = pick.id;
      }
      try {
        await dispatch("campaign:docs:addFile", { campaignId, path: uri.fsPath, label: basename(uri.fsPath) }, dispatchCtx);
        entityPanels.refreshCampaign(campaignId);
        vscode.window.showInformationMessage(`Octobots: added ${basename(uri.fsPath)} to the campaign.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Octobots: could not add file — ${(err as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("octoshell.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "octoshell"),
    ),
  );

  console.log(`[octoshell] host NODE_MODULE_VERSION=${process.versions.modules}`);
}

export function deactivate(): void {
  // No persistent resources to clean up (no daemon/AppRuntime).
}
