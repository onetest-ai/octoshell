// M6 T6.4: the campaign panel's test summary (mission AC5), over real board data.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CampaignView } from "../src/webview/campaign-view.js";
import { realRpc, type RealRpc } from "./fixtures/real-rpc.js";

afterEach(cleanup);
const noop = (): void => {};
const CAMPAIGN = "direct-dispatch-process";

const campaignOf = (r: RealRpc) => r.board.listCampaigns().find((c) => c.folderPath.endsWith(CAMPAIGN))!;

function show(r: RealRpc, campaignId: string, onOpenMission: (id: string) => void = noop) {
  return render(
    <CampaignView id={campaignId} rpc={r.rpc} onOpenMission={onOpenMission} onOpenBug={noop} onDeleteMission={noop}
      onNewMission={noop} onOpenDoc={noop} onAddLink={noop} onAttachFile={noop} onOpenFile={noop} />,
  );
}

describe("campaign panel: test summary", () => {
  it("shows totals by status including unknown, and the uncovered-AC count", async () => {
    const r = realRpc();
    const camp = campaignOf(r);
    const summary = (await r.rpc.call("tests:summary", { campaignId: camp.id }))!;
    expect(summary.total).toBeGreaterThan(50);
    show(r, camp.id);
    const section = await screen.findByRole("region", { name: "Tests" });
    for (const status of ["pass", "fail", "blocked", "ready", "draft", "unknown"] as const) {
      const item = await within(section).findByTestId(`total-${status}`);
      expect(item.textContent).toContain(status);
      expect(item.textContent).toContain(String(summary.counts[status]));
    }
    const unc = within(section).getByTestId("uncovered-total");
    expect(unc.textContent).toContain(String(summary.uncovered));
    if (summary.uncovered > 0) expect(unc.className + unc.innerHTML).toMatch(/text-status-warning/);
    expect(unc.className + unc.innerHTML).not.toMatch(/status-error/);
  });

  it("each mission row links to its mission panel through the open-mission handler", async () => {
    const r = realRpc();
    const camp = campaignOf(r);
    const summary = (await r.rpc.call("tests:summary", { campaignId: camp.id }))!;
    const row = summary.missions.find((m) => m.missionId && m.total > 0)!;
    const onOpen = vi.fn();
    show(r, camp.id, onOpen);
    const section = await screen.findByRole("region", { name: "Tests" });
    const rows = await within(section).findAllByTestId("summary-row");
    expect(rows).toHaveLength(summary.missions.length);
    const mine = rows.find((x) => x.getAttribute("data-folder") === row.folder)!;
    fireEvent.click(within(mine).getByRole("button", { name: new RegExp(`Open ${row.mission}\\b`) }));
    expect(onOpen).toHaveBeenCalledWith(row.missionId);
  });

  it("an orphan tests folder renders plainly with no link", async () => {
    const r = realRpc();
    const camp = campaignOf(r);
    const dir = join(r.octo, camp.folderPath, "tests", "m99");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TC-001_x.md"), "---\nid: TC-001\ntitle: o\nmission: M99\ncovers: [M99-AC1]\nkind: unit\nstatus: pass\n---\n\n# TC-001\n");
    r.board.reconcile();
    show(r, camp.id);
    const section = await screen.findByRole("region", { name: "Tests" });
    const row = (await within(section).findAllByTestId("summary-row")).find((x) => x.getAttribute("data-folder") === "m99")!;
    expect(within(row).getByText(/tests\/m99, no matching mission/)).toBeTruthy();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(within(row).queryAllByRole("link")).toHaveLength(0);
  });

  it("lists a mission's uncovered ACs in warning style, and a cancelled mission contributes none", async () => {
    const r = realRpc();
    const camp = campaignOf(r);
    const summary = (await r.rpc.call("tests:summary", { campaignId: camp.id }))!;
    const target = r.board.listMissions(camp.id).find((m) => m.status !== "cancelled")!;
    r.board.setStatus("mission", target.id, "cancelled", { force: "test" });
    const after = (await r.rpc.call("tests:summary", { campaignId: camp.id }))!;
    expect(after.uncovered).toBeLessThanOrEqual(summary.uncovered);
    show(r, camp.id);
    const section = await screen.findByRole("region", { name: "Tests" });
    const rows = await within(section).findAllByTestId("summary-row");
    const cancelled = rows.find((x) => x.getAttribute("data-mission-id") === target.id)!;
    expect(cancelled.querySelector('[data-testid="uncovered-acs"]')).toBeNull();
    const withGaps = after.missions.find((m) => m.uncovered.length > 0);
    if (withGaps) {
      const row = rows.find((x) => x.getAttribute("data-folder") === withGaps.folder)!;
      const list = within(row).getByTestId("uncovered-acs");
      for (const ac of withGaps.uncovered) expect(list.textContent).toContain(ac);
      expect(list.className + list.innerHTML).toMatch(/text-status-warning/);
    }
  });

  it("refreshes the summary after a TC status change, one fetch per spine event", async () => {
    const r = realRpc();
    const camp = campaignOf(r);
    const dir = join(r.octo, camp.folderPath, "tests", "m6");
    const file = readdirSync(dir).filter((f) => /^TC-.*\.md$/.test(f)).sort()[0]!;
    const before = (await r.rpc.call("tests:summary", { campaignId: camp.id }))!;
    show(r, camp.id);
    const section = await screen.findByRole("region", { name: "Tests" });
    await within(section).findByTestId("total-pass");
    const old = /^status:\s*(\w+)/m.exec(readFileSync(join(dir, file), "utf8"))![1]! as keyof typeof before.counts;
    const next = old === "pass" ? "fail" : "pass";
    writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8").replace(/^status:.*$/m, `status: ${next}`));
    r.board.reconcile();
    const fetches = r.calls.filter((c) => c === "tests:summary").length;
    r.emit({ projectId: "workspace", campaignId: camp.id });
    await waitFor(() => expect(within(section).getByTestId(`total-${next}`).textContent).toContain(String(before.counts[next] + 1)));
    expect(r.calls.filter((c) => c === "tests:summary").length - fetches).toBe(1);
  });
});
