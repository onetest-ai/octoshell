import * as vscode from "vscode";
import type { BoardHost, CampaignRollup } from "./board-host.js";
import type { Campaign, Mission, Task, Bug } from "@octoshell/board";

type Node =
  | { type: "campaign"; campaign: Campaign }
  | { type: "mission"; mission: Mission }
  | { type: "task"; task: Task }
  | { type: "bug"; bug: Bug };

/** Map a mission/task status to its contributed status color (see package.json contributes.colors). */
function statusColor(status: string): vscode.ThemeColor {
  switch (status) {
    case "executing": return new vscode.ThemeColor("octoshell.mission.executing");
    case "awaitingApproval": return new vscode.ThemeColor("octoshell.mission.awaiting");
    case "done": return new vscode.ThemeColor("octoshell.mission.done");
    case "failed": return new vscode.ThemeColor("octoshell.mission.failed");
    case "cancelled": return new vscode.ThemeColor("octoshell.mission.cancelled");
    default: return new vscode.ThemeColor("octoshell.mission.draft");
  }
}

/**
 * Map a campaign's EFFECTIVE status — `campaignRollup(id).rollupStatus`, which already encodes the
 * explicit-status-overrides-rollup precedence — to a status color, matching the in-app pill exactly.
 * BoardHost rollup uses numeric buckets (active/completed/failed/cancelled/draft) rather than a
 * per-status-name breakdown, so the "active" case uses the awaiting color as the most salient.
 */
function campaignStatusColor(rollup: CampaignRollup): vscode.ThemeColor {
  switch (rollup.rollupStatus) {
    case "active":
      // Surface the most salient open state on the icon: awaiting (attention) > executing.
      // CampaignRollup has no per-status breakdown, so treat all active as potentially awaiting.
      return statusColor("awaitingApproval");
    case "failed": return statusColor("failed");
    case "completed": return statusColor("done");
    case "cancelled": return statusColor("cancelled");
    default: return statusColor("draft"); // empty | draft
  }
}

export class CampaignsTree implements vscode.TreeDataProvider<Node> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  constructor(private readonly board: BoardHost) {}

  refresh(): void {
    this._changed.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "campaign") {
      const item = new vscode.TreeItem(node.campaign.name, vscode.TreeItemCollapsibleState.Collapsed);
      const rollup = this.board.campaignRollup(node.campaign.id);
      item.iconPath = rollup
        ? new vscode.ThemeIcon("milestone", campaignStatusColor(rollup))
        : new vscode.ThemeIcon("milestone", statusColor("draft"));
      item.contextValue = "octoshell.campaign";
      item.command = { command: "octoshell.openCampaignById", title: "Open Campaign", arguments: [node.campaign.id] };
      return item;
    }
    if (node.type === "mission") {
      const item = new vscode.TreeItem(node.mission.title, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = node.mission.status;
      item.iconPath = new vscode.ThemeIcon("target", statusColor(node.mission.status));
      item.contextValue = "octoshell.mission";
      item.command = { command: "octoshell.openMissionById", title: "Open Mission", arguments: [node.mission.id] };
      return item;
    }
    if (node.type === "task") {
      const item = new vscode.TreeItem(node.task.name, vscode.TreeItemCollapsibleState.None);
      item.description = node.task.status;
      item.iconPath = new vscode.ThemeIcon("checklist", statusColor(node.task.status));
      item.contextValue = "octoshell.task";
      item.command = { command: "octoshell.openTaskById", title: "Open Task", arguments: [node.task.id] };
      return item;
    }
    const item = new vscode.TreeItem(node.bug.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.bug.severity} · ${node.bug.status}`;
    item.iconPath = new vscode.ThemeIcon("bug", statusColor(node.bug.status));
    item.contextValue = "octoshell.bug";
    item.command = { command: "octoshell.openBugById", title: "Open Bug", arguments: [node.bug.id] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.board.listCampaigns().map((campaign) => ({ type: "campaign", campaign }));
    }
    if (node.type === "campaign") {
      return [
        ...this.board.listMissions(node.campaign.id).map((mission) => ({ type: "mission", mission }) as Node),
        ...this.board.listBugs({ campaignId: node.campaign.id }).map((bug) => ({ type: "bug", bug }) as Node),
      ];
    }
    if (node.type === "mission") {
      return [
        ...this.board.listTasks(node.mission.id).map((task) => ({ type: "task", task }) as Node),
        ...this.board.listBugs({ missionId: node.mission.id }).map((bug) => ({ type: "bug", bug }) as Node),
      ];
    }
    return [];
  }
}
