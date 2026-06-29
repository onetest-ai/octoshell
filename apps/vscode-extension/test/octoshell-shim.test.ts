// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createRpcClient } from "../src/webview/rpc-client.js";

describe("rpc-client", () => {
  it("posts an rpc message and resolves on matching result", async () => {
    const posted: unknown[] = [];
    const vscodeApi = { postMessage: (m: unknown) => posted.push(m) };
    const client = createRpcClient(vscodeApi);

    const p = client.call("chat:list", { projectId: "p1" });
    const sent = posted[0] as { type: string; id: number; method: string; args: unknown };
    expect(sent.type).toBe("rpc");
    expect(sent.method).toBe("chat:list");

    window.dispatchEvent(new MessageEvent("message", { data: { type: "rpc:result", id: sent.id, ok: true, value: [{ id: "c1" }] } }));
    await expect(p).resolves.toEqual([{ id: "c1" }]);
  });

  it("rejects on ok:false", async () => {
    const vscodeApi = { postMessage: () => {} };
    const client = createRpcClient(vscodeApi);
    const p = client.call("agent:info", { projectId: "p1", agentId: "x" });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "rpc:result", id: 1, ok: false, error: "boom" } }));
    await expect(p).rejects.toThrow("boom");
  });

  it("fans spine:event payloads to subscribers", () => {
    const vscodeApi = { postMessage: () => {} };
    const client = createRpcClient(vscodeApi);
    const cb = vi.fn();
    const off = client.onSpineEvent(cb);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "spine:event", payload: { kind: "chat:token", text: "hi" } } }));
    expect(cb).toHaveBeenCalledWith({ kind: "chat:token", text: "hi" });
    off();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "spine:event", payload: { kind: "chat:token", text: "bye" } } }));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
