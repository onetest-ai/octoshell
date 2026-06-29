// apps/vscode-extension/src/webview/rpc-client.ts
import { asHostEvent, type RpcMethod, type RpcArgsOf, type RpcResultOf, type SpineEventPayload }
  from "../protocol/index.js";

interface VsCodeApi { postMessage(msg: unknown): void; }
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export interface RpcClient {
  call: <M extends RpcMethod>(method: M, args: RpcArgsOf<M>) => Promise<RpcResultOf<M>>;
  onSpineEvent: (cb: (ev: SpineEventPayload) => void) => () => void;
}

export function createRpcClient(vscodeApi: VsCodeApi): RpcClient {
  const pending = new Map<number, Pending>();
  const listeners = new Set<(ev: SpineEventPayload) => void>();
  let nextId = 1;

  window.addEventListener("message", (e: MessageEvent) => {
    const ev = asHostEvent(e.data);
    if (!ev) return;
    if (ev.type === "rpc:result") {
      const p = pending.get(ev.id);
      if (!p) return;
      pending.delete(ev.id);
      if (ev.ok) p.resolve(ev.value);
      else p.reject(new Error(ev.error ?? "rpc error"));
    } else if (ev.type === "spine:event") {
      for (const cb of listeners) cb(ev.payload);
    }
  });

  return {
    call<M extends RpcMethod>(method: M, args: RpcArgsOf<M>): Promise<RpcResultOf<M>> {
      const id = nextId++;
      return new Promise<RpcResultOf<M>>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        vscodeApi.postMessage({ type: "rpc", id, method, args });
      });
    },
    onSpineEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
