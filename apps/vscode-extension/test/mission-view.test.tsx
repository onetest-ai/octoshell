import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MissionView } from "../src/webview/mission-view.js";

function fakeRpc(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const data: Record<string, unknown> = {
    "mission:get": { id: "m1", campaignId: "camp1", title: "Draft a Q3 report", status: "executing", description: "", acceptanceCriteria: "" },
    "task:list": [{ id: "t1", missionId: "m1", name: "Profile the API", status: "draft" }],
    "bug:list": [],
    "bug:sync": { created: 0 },
    "mission:docs": { files: [], attachedFiles: [], links: [] },
    "teams:list": [],
    "team:getBinding": null,
    "team:assignments": [],
    ...overrides,
  };
  return {
    calls,
    call: vi.fn(async (method: string, args: unknown) => { calls.push({ method, args }); return data[method]; }),
    onSpineEvent: () => () => {},
  };
}

describe("MissionView", () => {
  it("renders title/status and the task", async () => {
    const rpc = fakeRpc();
    render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText("Draft a Q3 report");
    expect(document.querySelector('[data-status="executing"]')).toBeTruthy();
    expect(screen.getByText(/Profile the API/)).toBeTruthy(); // the persisted task row
  });

  it("Status select reflects the mission status and changing it calls mission:setStatus", async () => {
    const rpc = fakeRpc();
    render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText("Draft a Q3 report");
    const sel = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(sel.value).toBe("executing");
    fireEvent.change(sel, { target: { value: "done" } });
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "mission:setStatus" && (c.args as { status?: string }).status === "done")).toBe(true));
  });

  it("lists tasks and fires onNewTask from the + New task button", async () => {
    const rpc = fakeRpc();
    const onNewTask = vi.fn();
    render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={onNewTask} />);
    await screen.findByText("Profile the API"); // a persistent task row
    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    expect(onNewTask).toHaveBeenCalled();
  });

  it("shows an empty state when the mission is missing", async () => {
    const rpc = fakeRpc({ "mission:get": null });
    render(<MissionView id="mX" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText(/not found/i);
  });

  it("does NOT call execution-era routes (mission:cancel, team:runStatus, mission:sessions)", async () => {
    const rpc = fakeRpc();
    render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText("Draft a Q3 report");
    const executionRoutes = ["mission:cancel", "team:runStatus", "mission:sessions", "team:start", "team:stop"];
    for (const route of executionRoutes) {
      expect(rpc.calls.some((c) => c.method === route)).toBe(false);
    }
  });

  it("renders a read-only Estimate block when tokenomics is present", async () => {
    const rpc = fakeRpc({
      "mission:get": {
        id: "m1", campaignId: "camp1", title: "Draft a Q3 report", status: "executing",
        description: "", acceptanceCriteria: "",
        tokenomics: { size: "M", effort_days: 3, complexity_score: 7, maturity: "prototype" },
      },
    });
    render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText("Draft a Q3 report");
    expect(screen.getByText(/Estimate/i)).toBeTruthy();
    expect(screen.getByText(/effort days/i)).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("M")).toBeTruthy();
    expect(screen.getByText(/maturity/i)).toBeTruthy();
    expect(screen.getByText("prototype")).toBeTruthy();
  });

  it("renders NO Estimate block when tokenomics is absent", async () => {
    const rpc = fakeRpc();
    render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText("Draft a Q3 report");
    expect(screen.queryByText(/Estimate/i)).toBeNull();
  });

  it("header has no emoji glyphs", async () => {
    const rpc = fakeRpc();
    const { container } = render(<MissionView id="m1" rpc={rpc as never} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText("Draft a Q3 report");
    const header = container.querySelector("header");
    expect(header?.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
