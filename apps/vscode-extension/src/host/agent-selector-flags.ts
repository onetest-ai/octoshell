import * as vscode from "vscode";
import { CURATED_PROVIDERS } from "../providers.js";

/** Per-provider default visibility for the persona (sub-agent) selector chip. */
export const AGENT_SELECTOR_DEFAULTS: Record<string, boolean> = {
  "claude-acp": true,
  "github-copilot-cli": false,
  "codex-acp": false,
};

/**
 * Pure: resolve show/hide flags for the given provider ids. `override(id)` returns the
 * user's explicit setting or `undefined` when unset; unset falls back to the per-provider
 * default, and any provider with no default is shown (`true`) so nothing regresses.
 */
export function resolveAgentSelectorFlags(
  providerIds: string[],
  override: (id: string) => boolean | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of providerIds) {
    out[id] = override(id) ?? AGENT_SELECTOR_DEFAULTS[id] ?? true;
  }
  return out;
}

/** Host wrapper: read `octoshell.providers.<id>.agentSelector` from VS Code config. */
export function readAgentSelectorFlags(): Record<string, boolean> {
  const c = vscode.workspace.getConfiguration("octoshell");
  return resolveAgentSelectorFlags(
    CURATED_PROVIDERS.map((p) => p.id),
    (id) => c.get<boolean>(`providers.${id}.agentSelector`),
  );
}
