import type { RpcClient } from "./rpc-client.js";
import type { Workflow, WorkflowMeta } from "@octoshell/board";

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
  workflows: {
    list: (parent: { campaignId?: string; missionId?: string }) => Promise<Workflow[]>;
    get: (workflowId: string) => Promise<Workflow | null>;
    create: (name: string, parent: { campaignId?: string; missionId?: string }) => Promise<{ id: string; folderPath: string }>;
    setMeta: (workflowId: string, meta: WorkflowMeta) => Promise<{ ok: true }>;
    remove: (workflowId: string) => Promise<{ ok: true }>;
    openScript: (workflowId: string) => Promise<{ ok: true }>;
  };
  settings: {
    getAppearance: () => Promise<unknown>;
    setAppearance: (value: unknown) => Promise<{ ok: true }>;
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
    workflows: {
      list: (parent) => c("workflow:list", parent) as never,
      get: (workflowId) => c("workflow:get", { workflowId }) as never,
      create: (name, parent) => c("workflow:create", { name, ...parent }) as never,
      setMeta: (workflowId, meta) => c("workflow:setMeta", { workflowId, meta }) as never,
      remove: (workflowId) => c("workflow:delete", { workflowId }) as never,
      openScript: (workflowId) => c("workflow:openScript", { workflowId }) as never,
    },
    settings: {
      getAppearance: () => c("settings:getAppearance", {}) as never,
      setAppearance: (value) => c("settings:setAppearance", { value }) as never,
    },
  };
}
