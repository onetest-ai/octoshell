import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowView } from "../src/webview/workflow-view.js";
import type { RpcClient } from "../src/webview/rpc-client.js";

const WF = {
  id: "folder:campaigns/a/workflows/w",
  campaignId: "c1", missionId: null,
  name: "build-tasks", description: "Drive each task to a PR",
  phases: [{ title: "Build", steps: [{ id: "s1", agent: "impl", label: "Build it" }] }],
  scriptPath: "campaigns/a/workflows/w/workflow.js",
  folderPath: "campaigns/a/workflows/w",
  parseError: null, lastRunStatus: "done", createdAt: 1, updatedAt: 1,
};

function stubRpc(overrides: Record<string, unknown> = {}): { rpc: RpcClient; calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  const rpc = {
    call: vi.fn(async (method: string, args: unknown) => {
      calls.push([method, args]);
      if (method in overrides) return overrides[method];
      if (method === "workflow:get") return WF;
      return { ok: true };
    }),
    onSpineEvent: () => () => {},
  } as unknown as RpcClient;
  return { rpc, calls };
}

describe("WorkflowView", () => {
  it("renders the name, description and diagram", async () => {
    const { rpc } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    expect(await screen.findByText("build-tasks")).toBeTruthy();
    expect(await screen.findByText(WF.description)).toBeTruthy();
    expect(await screen.findByText("Build it")).toBeTruthy();
    expect(await screen.findByText("impl")).toBeTruthy();
  });

  it("shows the run status", async () => {
    const { rpc } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    expect(await screen.findByText(/last run: done/i)).toBeTruthy();
  });

  it("shows the parse error and withholds the diagram when the script is unreadable", async () => {
    const broken = { ...WF, parseError: "no `export const meta` object literal found in workflow.js", phases: [] };
    const { rpc } = stubRpc({ "workflow:get": broken });
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    expect(await screen.findByText(broken.parseError)).toBeTruthy();
    expect(screen.getByText(/script could not be read/i)).toBeTruthy();
  });

  it("opens the script", async () => {
    const { rpc, calls } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    fireEvent.click(await screen.findByRole("button", { name: /open script/i }));
    await waitFor(() => {
      expect(calls.some(([m]) => m === "workflow:openScript")).toBe(true);
    });
  });
});
