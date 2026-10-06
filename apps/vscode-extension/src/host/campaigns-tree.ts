import * as vscode from "vscode";
import type { BoardHost, CampaignRollup } from "./board-host.js";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Campaign, Mission, Task, Bug, TestCase, TestCaseStatus } from "@octoshell/board";
import { formatCounts, groupLabel, TEST_STATUS_ORDER } from "./test-summary.js";

type Node =
  | { type: "campaign"; campaign: Campaign }
  | { type: "mission"; mission: Mission }
  | { type: "task"; task: Task }
  | { type: "bug"; bug: Bug }
  // M6: the campaign's test cases: `Tests` > one group per mission folder > one leaf per TC.
  | { type: "tests"; campaignId: string }
  | { type: "testGroup"; campaignId: string; folder: string }
  | { type: "testCase"; test: TestCase };

/** Status icon of a TC leaf: a codicon plus a `testing.*` theme colour (never a hardcoded one). */
const TEST_ICON: Record<TestCaseStatus, { icon: string; color: string }> = {
  pass: { icon: "pass", color: "testing.iconPassed" },
  fail: { icon: "error", color: "testing.iconFailed" },
  blocked: { icon: "circle-slash", color: "testing.iconSkipped" },
  ready: { icon: "circle-large-outline", color: "testing.iconQueued" },
  draft: { icon: "edit", color: "testing.iconUnset" },
  unknown: { icon: "question", color: "testing.iconUnset" },
};

/** The command a TC leaf runs: extension.ts routes it to the dispatcher's `editor.openFile`. */
export const OPEN_TEST_FILE_COMMAND = "octoshell.openTestFile";

const inside = (root: string, p: string): string | null => {
  const rel = relative(root, p);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
};

/**
 * The file {@link OPEN_TEST_FILE_COMMAND} may open: an existing `TC-*.md` under `<board>/campaigns/<c>/tests/`,
 * after resolving `..` and symlinks, or null (no argument, a non-string, another file, a path that leaves the
 * board). The command is callable by anything that can run a command, so its argument is never trusted.
 */
export function testFileToOpen(boardRoot: string, arg: unknown): string | null {
  if (typeof arg !== "string" || arg.length === 0) return null;
  const abs = resolve(arg);
  if (!existsSync(abs) || !existsSync(boardRoot)) return null;
  const rel = inside(realpathSync(boardRoot), realpathSync(abs));
  if (!rel || inside(resolve(boardRoot), abs) === null) return null;
  const parts = rel.split(sep);
  return parts.length >= 4 && parts[0] === "campaigns" && parts[2] === "tests" && /^TC-[^\\/]*\.md$/.test(parts[parts.length - 1]!)
    ? abs
    : null;
}

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
    if (node.type === "tests") return this.testsItem(node.campaignId);
    if (node.type === "testGroup") return this.testGroupItem(node.campaignId, node.folder);
    if (node.type === "testCase") return this.testCaseItem(node.test);
    const item = new vscode.TreeItem(node.bug.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.bug.severity} · ${node.bug.status}`;
    item.iconPath = new vscode.ThemeIcon("bug", statusColor(node.bug.status));
    item.contextValue = "octoshell.bug";
    item.command = { command: "octoshell.openBugById", title: "Open Bug", arguments: [node.bug.id] };
    return item;
  }

  private testsItem(campaignId: string): vscode.TreeItem {
    const s = this.board.testSummary(campaignId);
    const item = new vscode.TreeItem("Tests", vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `tests:${campaignId}`;
    item.iconPath = new vscode.ThemeIcon("beaker");
    item.contextValue = "octoshell.tests";
    if (s) item.description = `${s.total} · ${formatCounts(s.counts)}`;
    return item;
  }

  private testGroupItem(campaignId: string, folder: string): vscode.TreeItem {
    const row = this.board.testSummary(campaignId)?.missions.find((m) => m.folder === folder);
    const item = new vscode.TreeItem(row ? groupLabel(folder, row.total, row.counts) : folder, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `tests:${campaignId}:${folder}`;
    item.iconPath = new vscode.ThemeIcon("beaker");
    item.contextValue = "octoshell.testGroup";
    if (row) {
      const lines = [row.title ?? `${row.mission} (no matching mission)`];
      for (const st of TEST_STATUS_ORDER) if (row.counts[st] > 0) lines.push(`${row.counts[st]} ${st}`);
      if (row.counts.unknown > 0)
        lines.push("unknown = no status in the file's frontmatter (a legacy test case); `set-test-status.js <file> --migrate` adds it.");
      item.tooltip = lines.join("\n");
    }
    return item;
  }

  private testCaseItem(tc: TestCase): vscode.TreeItem {
    const item = new vscode.TreeItem(`${tc.id}: ${tc.title}`, vscode.TreeItemCollapsibleState.None);
    const abs = join(this.board.artifactsRoot, tc.path);
    const icon = TEST_ICON[tc.status];
    item.id = `tc:${tc.path}`;
    item.description = tc.status;
    item.iconPath = new vscode.ThemeIcon(icon.icon, new vscode.ThemeColor(icon.color));
    item.tooltip = [tc.path, tc.lastRun ? `last run ${tc.lastRun.date}` : "never run"].join("\n");
    item.contextValue = "octoshell.testCase";
    item.command = { command: OPEN_TEST_FILE_COMMAND, title: "Open Test Case", arguments: [abs] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.board.listCampaigns().map((campaign) => ({ type: "campaign", campaign }));
    }
    if (node.type === "campaign") {
      const tests: Node[] = this.board.listTests(node.campaign.id).length > 0 ? [{ type: "tests", campaignId: node.campaign.id }] : [];
      return [
        ...this.board.listMissions(node.campaign.id).map((mission) => ({ type: "mission", mission }) as Node),
        ...this.board.listBugs({ campaignId: node.campaign.id }).map((bug) => ({ type: "bug", bug }) as Node),
        ...tests,
      ];
    }
    if (node.type === "mission") {
      return [
        ...this.board.listTasks(node.mission.id).map((task) => ({ type: "task", task }) as Node),
        ...this.board.listBugs({ missionId: node.mission.id }).map((bug) => ({ type: "bug", bug }) as Node),
      ];
    }
    if (node.type === "tests") {
      const rows = this.board.testSummary(node.campaignId)?.missions ?? [];
      return rows.filter((r) => r.total > 0).map((r) => ({ type: "testGroup", campaignId: node.campaignId, folder: r.folder }) as Node);
    }
    if (node.type === "testGroup") {
      return this.board.listTests(node.campaignId, node.folder).map((test) => ({ type: "testCase", test }) as Node);
    }
    return [];
  }
}
