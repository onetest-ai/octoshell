import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardHost } from "../src/host/board-host.js";
import { realBoardCopies } from "./fixtures/real-board.js";

vi.mock("vscode", () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class { event = (): void => {}; fire(): void {} },
}));

const { CampaignsTree } = await import("../src/host/campaigns-tree.js");

type TreeNode = ReturnType<InstanceType<typeof CampaignsTree>["getChildren"]>[number];

function walk(tree: InstanceType<typeof CampaignsTree>): TreeNode[] {
  const all: TreeNode[] = [];
  const visit = (n?: TreeNode): void => {
    for (const child of tree.getChildren(n)) {
      all.push(child);
      visit(child);
    }
  };
  visit();
  return all;
}

describe("CampaignsTree over a real board", () => {
  it("every campaign, mission, task and bug is a node, and no workflow is", () => {
    for (const dir of realBoardCopies()) {
      // The repo's own board has workflows/ only under missions; plant one under a campaign too, so
      // a campaign-level workflow node cannot come back unnoticed.
      const first = new BoardHost(dir).listCampaigns()[0]!;
      const planted = join(dir, first.folderPath, "workflows", "planted");
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, "workflow.js"), "export const meta = { name: 'planted', phases: [] };\n");
      const board = new BoardHost(dir);
      const campaigns = board.listCampaigns();
      expect(campaigns.length).toBeGreaterThan(0);

      const missions = campaigns.flatMap((c) => board.listMissions(c.id));
      const tasks = missions.flatMap((m) => board.listTasks(m.id));
      const bugs = [
        ...campaigns.flatMap((c) => board.listBugs({ campaignId: c.id })),
        ...missions.flatMap((m) => board.listBugs({ missionId: m.id })),
      ];
      expect(missions.length).toBeGreaterThan(0);
      expect(tasks.length).toBeGreaterThan(0);

      const nodes = walk(new CampaignsTree(board));
      const ids = (type: string): string[] =>
        nodes.filter((n) => n.type === type).map((n) => (n as unknown as Record<string, { id: string }>)[type]!.id).sort();

      expect(ids("campaign")).toEqual(campaigns.map((c) => c.id).sort());
      expect(ids("mission")).toEqual(missions.map((m) => m.id).sort());
      expect(ids("task")).toEqual(tasks.map((t) => t.id).sort());
      expect(ids("bug")).toEqual(bugs.map((b) => b.id).sort());
      expect(nodes.filter((n) => (n.type as string) === "workflow")).toHaveLength(0);
    }
  });
});
