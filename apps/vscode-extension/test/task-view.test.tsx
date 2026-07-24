import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskView } from "../src/webview/task-view.js";

function fakeRpc(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const data: Record<string, unknown> = {
    "task:get": { id: "t1", missionId: "m1", name: "Profile the API", status: "draft", description: "do it", acceptanceCriteria: "p95<100ms" },
    ...overrides,
  };
  return {
    calls,
    call: vi.fn(async (method: string, args: unknown) => { calls.push({ method, args }); return data[method]; }),
    onSpineEvent: () => () => {},
  };
}

describe("TaskView", () => {
  it("renders name/status", async () => {
    const rpc = fakeRpc();
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    expect(document.querySelector('[data-status="draft"]')).toBeTruthy();
  });

  it("Status select reflects the task status and changing it calls task:setStatus", async () => {
    const rpc = fakeRpc();
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    const sel = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(sel.value).toBe("draft");
    fireEvent.change(sel, { target: { value: "done" } });
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "task:setStatus" && (c.args as { status?: string }).status === "done")).toBe(true));
  });

  it("autosaves the Description field via task:update", async () => {
    const rpc = fakeRpc();
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    const ta = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "new body" } });
    fireEvent.blur(ta);
    await waitFor(() => {
      expect(rpc.calls.some((c) => c.method === "task:update")).toBe(true);
    });
    expect(rpc.calls.find((c) => c.method === "task:update")?.args).toMatchObject({ taskId: "t1", description: "new body" });
  });

  it("shows an empty state when the task is missing", async () => {
    const rpc = fakeRpc({ "task:get": null });
    render(<TaskView id="tX" rpc={rpc as never} />);
    await screen.findByText(/not found/i);
  });

  it("renders a read-only Estimate block when tokenomics is present", async () => {
    const rpc = fakeRpc({
      "task:get": {
        id: "t1", missionId: "m1", name: "Profile the API", status: "draft",
        description: "do it", acceptanceCriteria: "p95<100ms",
        tokenomics: { size: "S", effort_days: 1, complexity_score: 2 },
      },
    });
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    expect(screen.getByText(/Estimate/i)).toBeTruthy();
    expect(screen.getByText(/effort days/i)).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/complexity score/i)).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("renders NO Estimate block when tokenomics is absent", async () => {
    const rpc = fakeRpc();
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    expect(screen.queryByText(/Estimate/i)).toBeNull();
  });

  it("does NOT render Start or Cancel buttons (execution-era removed)", async () => {
    const rpc = fakeRpc();
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel task/i })).toBeNull();
  });

  it("does NOT call task:start or task:sessions (execution-era removed)", async () => {
    const rpc = fakeRpc();
    render(<TaskView id="t1" rpc={rpc as never} />);
    await screen.findByText("Profile the API");
    expect(rpc.calls.some((c) => c.method === "task:start")).toBe(false);
    expect(rpc.calls.some((c) => c.method === "task:sessions")).toBe(false);
  });
});
