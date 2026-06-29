import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BugView } from "../src/webview/bug-view.js";

function fakeRpc(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const data: Record<string, unknown> = {
    "bug:get": { id: "bug1", campaignId: null, missionId: "m1", title: "Login crashes", status: "draft", severity: "major", description: "boom", stepsToReproduce: "1. click", expected: "ok", actual: "crash", rca: "", environment: "Safari" },
    ...overrides,
  };
  return {
    calls,
    call: vi.fn(async (method: string, args: unknown) => { calls.push({ method, args }); return data[method]; }),
    onSpineEvent: () => () => {},
  };
}

describe("BugView", () => {
  it("renders title/status/severity", async () => {
    const rpc = fakeRpc();
    render(<BugView id="bug1" rpc={rpc as never} />);
    await screen.findByText("Login crashes");
    expect(document.querySelector('[data-status="draft"]')).toBeTruthy();
  });

  it("autosaves Steps to Reproduce via bug:update", async () => {
    const rpc = fakeRpc();
    render(<BugView id="bug1" rpc={rpc as never} />);
    await screen.findByText("Login crashes");
    const ta = screen.getByLabelText(/steps to reproduce/i) as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "1. open  2. boom" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "bug:update")).toBe(true));
    expect(rpc.calls.find((c) => c.method === "bug:update")?.args).toMatchObject({ bugId: "bug1", stepsToReproduce: "1. open  2. boom" });
  });

  it("changing severity calls bug:update", async () => {
    const rpc = fakeRpc();
    render(<BugView id="bug1" rpc={rpc as never} />);
    await screen.findByText("Login crashes");
    const sel = screen.getByLabelText(/severity/i) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "blocker" } });
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "bug:update" && (c.args as { severity?: string }).severity === "blocker")).toBe(true));
  });

  it("Status select reflects the bug status and changing it calls bug:setStatus", async () => {
    const rpc = fakeRpc();
    render(<BugView id="bug1" rpc={rpc as never} />);
    await screen.findByText("Login crashes");
    const sel = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(sel.value).toBe("draft");
    fireEvent.change(sel, { target: { value: "done" } });
    await waitFor(() => expect(rpc.calls.some((c) => c.method === "bug:setStatus" && (c.args as { status?: string }).status === "done")).toBe(true));
  });

  it("does NOT render Start or Cancel buttons (execution-era removed)", async () => {
    const rpc = fakeRpc();
    render(<BugView id="bug1" rpc={rpc as never} />);
    await screen.findByText("Login crashes");
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel bug/i })).toBeNull();
  });

  it("does NOT render 'assign to mission' hint (execution-era removed)", async () => {
    const rpc = fakeRpc({ "bug:get": { id: "bug1", campaignId: "c1", missionId: null, title: "X", status: "draft", severity: "major", description: "", stepsToReproduce: "", expected: "", actual: "", rca: "", environment: "" } });
    render(<BugView id="bug1" rpc={rpc as never} />);
    await screen.findByText("X");
    expect(screen.queryByText(/assign.*mission/i)).toBeNull();
  });

  it("shows an empty state when the bug is missing", async () => {
    const rpc = fakeRpc({ "bug:get": null });
    render(<BugView id="bugX" rpc={rpc as never} />);
    await screen.findByText(/not found/i);
  });
});
