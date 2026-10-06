// An RpcClient for webview tests whose answers come from a real BoardHost through the real dispatcher, over a
// scratch copy of a tracked board (M6 T6.4). `emit()` stands in for the host's spine:event refresh.
import { join } from "node:path";
import { dispatch } from "../../src/host/rpc-dispatcher.js";
import { BoardHost } from "../../src/host/board-host.js";
import { AppearanceStore } from "../../src/host/appearance-store.js";
import { FakeMemento } from "../helpers.js";
import { trackedBoardCopies } from "./real-board.js";
import type { RpcClient } from "../../src/webview/rpc-client.js";

export interface RealRpc {
  board: BoardHost;
  octo: string;
  rpc: RpcClient;
  /** Every dispatched method, in order. */
  calls: string[];
  /** Replay a spine event to every subscriber, as the host does after entities:changed. */
  emit: (payload: Record<string, unknown>) => void;
}

export function realRpc(octo: string = trackedBoardCopies()[0]!): RealRpc {
  const board = new BoardHost(octo);
  const ctx = {
    board,
    appearanceStore: new AppearanceStore(new FakeMemento()),
    workspaceFolderPath: join(octo, ".."),
    dialog: { openFiles: async () => [], confirm: async () => false },
    editor: { openReadonly: async () => {}, openFile: async () => {} },
  };
  const calls: string[] = [];
  const listeners = new Set<(ev: never) => void>();
  const rpc = {
    call: async (method: string, args: unknown) => {
      calls.push(method);
      return dispatch(method as never, args as never, ctx as never);
    },
    onSpineEvent: (cb: (ev: never) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  } as unknown as RpcClient;
  return { board, octo, rpc, calls, emit: (p) => { for (const l of listeners) l(p as never); } };
}
