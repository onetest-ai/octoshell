import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const { CampaignsTree } = await import("../src/host/campaigns-tree.js");

const workflow = {
  id: "folder:campaigns/a/workflows/w", campaignId: "c1", missionId: null,
  name: "ship", description: "", phases: [], scriptPath: "campaigns/a/workflows/w/workflow.js",
  folderPath: "campaigns/a/workflows/w", usesPath: null, parseError: null, lastRunStatus: "done",
  createdAt: 1, updatedAt: 1,
};

const board = {
  listCampaigns: () => [{ id: "c1", name: "Alpha", folderPath: "campaigns/a", createdAt: 1 }],
  listMissions: () => [],
  listTasks: () => [],
  listBugs: () => [],
  listWorkflows: (p: { campaignId?: string }) => (p.campaignId === "c1" ? [workflow] : []),
  campaignRollup: () => ({ rollupStatus: "draft" }),
} as never;

describe("CampaignsTree workflows", () => {
  it("lists a campaign's workflows as children", () => {
    const tree = new CampaignsTree(board);
    const [campaign] = tree.getChildren();
    const children = tree.getChildren(campaign);
    expect(children.some((n: { type: string }) => n.type === "workflow")).toBe(true);
  });

  it("uses the circuit-board codicon", () => {
    const tree = new CampaignsTree(board);
    const item = tree.getTreeItem({ type: "workflow", workflow } as never);
    expect((item.iconPath as { id: string }).id).toBe("circuit-board");
    expect(item.contextValue).toBe("octoshell.workflow");
  });
});
