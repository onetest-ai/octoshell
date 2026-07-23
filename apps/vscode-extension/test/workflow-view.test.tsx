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
    expect(await screen.findByText("Build it")).toBeTruthy();
    expect(await screen.findByText("impl")).toBeTruthy();
  });

  it("writes a step edit back through workflow:setMeta", async () => {
    const { rpc, calls } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    const label = await screen.findByLabelText("Step s1 label");
    fireEvent.change(label, { target: { value: "Build it well" } });
    fireEvent.blur(label);
    await waitFor(() => {
      const call = calls.find(([m]) => m === "workflow:setMeta");
      expect(call).toBeDefined();
      const args = call![1] as { meta: { phases: { steps: { label: string }[] }[] } };
      expect(args.meta.phases[0]!.steps[0]!.label).toBe("Build it well");
    });
  });

  it("adds a step to a phase", async () => {
    const { rpc, calls } = stubRpc();
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    fireEvent.click(await screen.findByRole("button", { name: /add step/i }));
    await waitFor(() => {
      const call = calls.find(([m]) => m === "workflow:setMeta");
      const args = call![1] as { meta: { phases: { steps: unknown[] }[] } };
      expect(args.meta.phases[0]!.steps).toHaveLength(2);
    });
  });

  it("shows the parse error and hides the editor when the script is unreadable", async () => {
    const broken = { ...WF, parseError: "no `export const meta` object literal found in workflow.js", phases: [] };
    const { rpc } = stubRpc({ "workflow:get": broken });
    render(<WorkflowView id={WF.id} rpc={rpc} />);
    expect(await screen.findByText(broken.parseError)).toBeTruthy();
    expect(screen.getByText(/script could not be read/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
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
