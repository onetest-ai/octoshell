import type { RpcClient } from "./rpc-client.js";

/** Board-only webview API exposed on window.octoshell.
 * Declares only the namespaces actually wired to RPC calls.
 * The chat/tool/agent/workspace/sessions stubs that existed solely to satisfy
 * the former OctoshellApi type contract have been removed (B5 Task 9). */
export interface OctoshellExtApi {
  project: { list: () => Promise<{ id: string; name: string }[]>; open: (projectId: string) => Promise<{ ok: true }> };
  dialog: {
    openFolder: () => Promise<unknown>;
    openFiles: () => Promise<unknown>;
  };
  spine: {
    onEvent: (cb: (ev: unknown) => void) => () => void;
  };
  campaign: {
    list: () => Promise<unknown>;
  };
  mission: {
    get: (projectId: unknown, missionId: string) => Promise<unknown>;
  };
  settings: {
    getAppearance: () => Promise<unknown>;
    setAppearance: (value: unknown) => Promise<{ ok: true }>;
    listProviders: () => Promise<{ rows: never[]; registryStale: boolean }>;
    getPermissions: () => Promise<{ defaultApprovalMode: string | null }>;
    agentSelectorFlags: () => Promise<Record<string, boolean>>;
  };
  customizations: {
    list: () => Promise<unknown[]>;
    readFile: (path: string) => Promise<unknown>;
    writeFile: (path: string, content: string) => Promise<{ ok: true }>;
    add: (input: unknown) => Promise<unknown>;
  };
}

export function createOctoshellShim(rpc: RpcClient): OctoshellExtApi {
  const c = rpc.call;
  return {
    project: {
      list: () => c("project:list", {}) as never,
      open: (projectId) => c("project:open", { projectId }) as never,
    },
    dialog: {
      openFolder: () => c("dialog:openFolder", {}) as never,
      openFiles: () => c("dialog:openFiles", {}) as never,
    },
    spine: {
      onEvent: (cb) => rpc.onSpineEvent(cb as never),
    },
    campaign: {
      list: () => c("campaign:list", {}) as never,
    },
    mission: {
      get: (_p, missionId) => c("mission:get", { missionId }) as never,
    },
    settings: {
      getAppearance: () => c("settings:getAppearance", {}) as never,
      setAppearance: (value) => c("settings:setAppearance", { value }) as never,
      listProviders: () => c("settings:listProviders", {}) as never,
      getPermissions: () => c("settings:getPermissions", {}) as never,
      agentSelectorFlags: () => c("settings:agentSelectorFlags", {}) as never,
    },
    customizations: {
      list: () => c("customizations:list", {}) as never,
      readFile: (path) => c("customizations:readFile", { path }) as never,
      writeFile: (path, content) => c("customizations:writeFile", { path, content }) as never,
      add: (input) => c("customizations:add", { input }) as never,
    },
  };
}
