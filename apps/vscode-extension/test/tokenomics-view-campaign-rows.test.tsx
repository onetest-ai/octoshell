import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { emptyEstimate, emptyTotals, type MissionRun, type Report } from "@octoshell/tokenomics";
import { TokenomicsView } from "../src/webview/tokenomics-view.js";
import type { RpcClient } from "../src/webview/rpc-client.js";

const mission = (over: Partial<MissionRun> = {}): MissionRun => ({
  scope: "mission",
  missionId: "folder:campaigns/demo/missions/m1",
  missionTitle: "M1 - Demo mission",
  campaignId: "folder:campaigns/demo",
  estimate: { ...emptyEstimate(), effortDays: 4, sizeTshirt: "L" },
  branches: ["feat/demo-m1"],
  sessions: 1,
  turns: 100,
  subagentDispatches: 3,
  orchestratorCostPct: 60,
  cacheReadSharePct: 80,
  tokens: { ...emptyTotals(), output: 1_000_000 },
  costByModel: {},
  costUsd: 40,
  tasks: [],
  ...over,
});

const campaign = (over: Partial<MissionRun> = {}): MissionRun =>
  mission({
    scope: "campaign",
    missionId: null,
    missionTitle: "Demo campaign",
    estimate: { ...emptyEstimate(), branches: ["chore/demo-plan"] },
    branches: ["chore/demo-plan"],
    costUsd: 5,
    turns: 11,
    tasks: [],
    ...over,
  });

const report = (runs: MissionRun[]): Report => ({
  generatedAt: "2026-10-05T00:00:00.000Z",
  agentTool: "claude-code",
  pricesFetchedAt: null,
  runs,
  unattributed: { segments: 0, turns: 0, branches: [], tokens: emptyTotals(), costUsd: 0 },
  unpricedModels: [],
});

async function renderReport(r: Report): Promise<HTMLElement> {
  const rpc = { call: vi.fn(async () => r) } as unknown as RpcClient;
  const { container } = render(<TokenomicsView rpc={rpc} />);
  await screen.findByText("Tokenomics");
  return container;
}

const tile = (label: string): string =>
  screen.getByText(label).parentElement!.querySelector(".tok-tile-value")!.textContent!;

describe("TokenomicsView campaign rows", () => {
  it("Missions measured counts mission rows only", async () => {
    await renderReport(report([mission(), campaign()]));
    expect(tile("Missions measured")).toBe("1");
  });

  it("renders campaign rows under Campaign-level work, not in the Missions table", async () => {
    await renderReport(report([mission(), campaign()]));
    const heading = screen.getByRole("heading", { name: "Campaign-level work" });
    const table = heading.parentElement!.querySelectorAll("table");
    // Missions, Campaign-level work, Cost by size.
    const campaignTable = Array.from(table).find((t) => t.textContent?.includes("chore/demo-plan"))!;
    expect(within(campaignTable).getByText("Demo campaign")).toBeTruthy();
    const missionsTable = screen.getByRole("heading", { name: "Missions" }).nextElementSibling as HTMLElement;
    expect(within(missionsTable).queryByText("Demo campaign")).toBeNull();
    expect(within(missionsTable).getByText("M1 - Demo mission")).toBeTruthy();
  });

  it("omits the Campaign-level work section when there are none", async () => {
    await renderReport(report([mission()]));
    expect(screen.queryByRole("heading", { name: "Campaign-level work" })).toBeNull();
  });

  it("no-effort finding excludes campaign rows (1 of 2)", async () => {
    const noEffort = mission({ missionId: "folder:campaigns/demo/missions/m2", missionTitle: "M2 - x", estimate: emptyEstimate() });
    await renderReport(report([mission(), noEffort, campaign()]));
    expect(screen.getByText(/1 of 2 missions have no authored effort/)).toBeTruthy();
  });

  it("cost-by-size excludes campaign rows", async () => {
    await renderReport(report([mission(), campaign()]));
    const sizing = screen.getByRole("heading", { name: "Cost by size" }).parentElement!.querySelectorAll("table");
    const bySize = sizing[sizing.length - 1]!;
    expect(within(bySize).getByText("$40.00")).toBeTruthy();
    expect(bySize.textContent).not.toContain("$45.00");
    expect(bySize.textContent).not.toContain("—"); // no size-less bucket for the campaign row
  });

  it("total cost includes campaign rows", async () => {
    await renderReport(report([mission(), campaign()]));
    expect(tile("Total metered cost")).toBe("$45.00");
  });
});
