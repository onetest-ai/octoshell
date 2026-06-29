import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CampaignView } from "../src/webview/campaign-view.js";

function fakeRpc() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const data: Record<string, unknown> = {
    "campaign:get": { campaign: { id: "camp1", name: "Q3 Rollout", target: "cut triage 30%", acceptanceCriteria: "all P1s closed", description: "", status: "executing" }, summary: { counts: { done: 1 }, rollupStatus: "active", total: 1 } },
    "campaign:setStatus": { ok: true },
    "mission:list": [{ id: "m1", campaignId: "camp1", title: "Draft report", status: "done" }],
    "campaign:docs": { files: [{ name: "brief.md", kind: "file", size: 1, mtime: 1 }], attachedFiles: [{ id: "r3", kind: "file", target: "/repo/spec.md", label: "spec.md" }], links: [{ id: "r1", target: "https://notion.so/prd", label: "PRD" }] },
    "campaign:update": { ok: true },
    "campaign:docs:removeLink": { ok: true },
    "campaign:docs:createFile": { path: "/tmp/untitled.md" },
    "campaign:missions:sync": { proposals: [{ title: "Uptime checks", description: "ping", exists: false }, { title: "Done one", description: "", exists: true }] },
    "campaign:missions:create": { created: 1 },
    "bug:list": [],
    "bug:sync": { created: 0 },
    "teams:list": [],
    "team:getBinding": null,
    "team:assignments": [],
  };
  return {
    calls,
    call: vi.fn(async (method: string, args: unknown) => { calls.push({ method, args }); return data[method]; }),
    onSpineEvent: () => () => {},
  };
}

function renderView(extra: Record<string, unknown> = {}) {
  const rpc = fakeRpc();
  const props = {
    id: "camp1", rpc,
    onOpenMission: vi.fn(), onNewMission: vi.fn(),
    onOpenDoc: vi.fn(), onAddLink: vi.fn(), onAttachFile: vi.fn(), onOpenFile: vi.fn(),
    ...extra,
  };
  render(<CampaignView {...(props as never)} />);
  return { ...props, rpc };
}

describe("CampaignView (campaign unit)", () => {
  it("renders name, target, criteria, docs, links, and a mission", async () => {
    renderView();
    await screen.findByText("Q3 Rollout");
    expect((screen.getByLabelText(/target/i) as HTMLTextAreaElement).value).toContain("cut triage 30%");
    expect(screen.getByText("brief.md")).toBeTruthy();
    expect(screen.getByText(/spec\.md/)).toBeTruthy();
    expect(screen.getByText(/PRD/)).toBeTruthy();
    expect(screen.getByText("Draft report")).toBeTruthy();
  });

  it("renders board bugs and opens one via onOpenBug", async () => {
    const rpc = fakeRpc();
    (rpc.call as unknown as { mockImplementation: (fn: (m: string, a: unknown) => Promise<unknown>) => void }).mockImplementation(
      async (method: string, args: unknown) => {
        rpc.calls.push({ method, args });
        if (method === "bug:list") return [{ id: "bug1", title: "Login crash", severity: "critical", status: "draft" }];
        if (method === "bug:sync") return { created: 0 };
        if (method === "campaign:get") return { campaign: { id: "camp1", name: "Q3 Rollout", target: "", acceptanceCriteria: "", description: "" }, summary: { counts: {}, rollupStatus: "active", total: 0 } };
        if (method === "mission:list") return [];
        if (method === "campaign:docs") return { files: [], attachedFiles: [], links: [] };
        if (method === "campaign:missions:sync") return { proposals: [] };
        if (method === "teams:list") return [];
        if (method === "team:getBinding") return null;
        if (method === "team:assignments") return [];
        return undefined;
      },
    );
    const onOpenBug = vi.fn();
    render(<CampaignView id="camp1" rpc={rpc as never} onOpenMission={() => {}} onOpenBug={onOpenBug} onNewMission={() => {}} onOpenDoc={() => {}} onAddLink={() => {}} onAttachFile={() => {}} onOpenFile={() => {}} />);
    await screen.findByText("Login crash");
    expect(rpc.calls.some((c) => c.method === "bug:sync")).toBe(true);
    fireEvent.click(screen.getByText("Login crash"));
    expect(onOpenBug).toHaveBeenCalledWith("bug1");
  });

  it("autosaves target on blur via campaign:update", async () => {
    const rpc = fakeRpc();
    render(<CampaignView id="camp1" rpc={rpc as never} onOpenMission={() => {}} onNewMission={() => {}} onOpenDoc={() => {}} onAddLink={() => {}} onAttachFile={() => {}} onOpenFile={() => {}} />);
    await screen.findByText("Q3 Rollout");
    const ta = screen.getByLabelText(/target/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "new target" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "campaign:update")).toBe(true));
    expect(rpc.calls.find((c) => c.method === "campaign:update")?.args).toMatchObject({ campaignId: "camp1", target: "new target" });
  });

  it("doc/link/attach buttons call their host callbacks", async () => {
    const props = renderView();
    await screen.findByText("Q3 Rollout");
    fireEvent.click(screen.getByText("brief.md"));
    expect(props.onOpenDoc).toHaveBeenCalledWith("brief.md");
    fireEvent.click(screen.getByRole("button", { name: /attach link/i }));
    expect(props.onAddLink).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /attach file/i }));
    expect(props.onAttachFile).toHaveBeenCalled();
    fireEvent.click(screen.getByText(/spec\.md/));
    expect(props.onOpenFile).toHaveBeenCalledWith("/repo/spec.md");
  });

  it("syncs board proposals and creates the selected (non-existing) ones", async () => {
    const rpc = fakeRpc();
    render(<CampaignView id="camp1" rpc={rpc as never} onOpenMission={() => {}} onNewMission={() => {}} onOpenDoc={() => {}} onAddLink={() => {}} onAttachFile={() => {}} onOpenFile={() => {}} />);
    await screen.findByText("Q3 Rollout");
    fireEvent.click(screen.getByRole("button", { name: /sync missions from board/i }));
    await screen.findByText("Uptime checks");
    fireEvent.click(screen.getByRole("button", { name: /create selected/i }));
    await waitFor(() => expect(rpc.calls.some((x) => x.method === "campaign:missions:create")).toBe(true));
    const call = rpc.calls.find((x) => x.method === "campaign:missions:create");
    expect((call!.args as { missions: { title: string }[] }).missions.map((m) => m.title)).toEqual(["Uptime checks"]);
  });

  it("renders the Status dropdown bound to the campaign's status and sets it via campaign:setStatus", async () => {
    const { rpc } = renderView();
    await screen.findByText("Q3 Rollout");
    const select = screen.getByLabelText(/^Status$/i) as HTMLSelectElement;
    expect(select.value).toBe("executing");
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "campaign:setStatus")).toBe(true));
    expect(rpc.calls.find((c) => c.method === "campaign:setStatus")?.args).toMatchObject({ campaignId: "camp1", status: "done" });
  });

  it("does NOT call campaign:runStatus (execution-era, removed)", async () => {
    const { rpc } = renderView();
    await screen.findByText("Q3 Rollout");
    expect(rpc.calls.some((c) => c.method === "campaign:runStatus")).toBe(false);
  });
});
