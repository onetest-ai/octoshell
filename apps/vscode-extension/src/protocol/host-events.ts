// apps/vscode-extension/src/protocol/host-events.ts

// Minimal spine event payload as delivered host → webview.
// The host posts scoped board-refresh signals: { projectId, campaignId? | missionId? | taskId? | bugId? }.
// Webview consumers cast to a narrower shape, so a loose record is sufficient here.
export type SpineEventPayload = { projectId: string } & Record<string, unknown>;

/** host → webview: the bind envelope sent when a panel opens (or after webview-ready).
 *  The host posts one per entity kind: campaign, mission, task, or bug. */
export type BindMessage = { type: "bind"; kind: "campaign" | "mission" | "task" | "bug" | "workflow"; id: string };

export type HostEvent =
  | { type: "rpc:result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: "spine:event"; payload: SpineEventPayload }
  | BindMessage;

/** Narrow an unknown inbound message (on the webview side) to a HostEvent by `type`.
 *  The spine payload is our own daemon output and is not re-validated field-by-field. */
export function asHostEvent(msg: unknown): HostEvent | null {
  if (typeof msg !== "object" || msg === null) return null;
  const t = (msg as { type?: unknown }).type;
  if (t === "rpc:result" || t === "spine:event" || t === "bind") return msg as HostEvent;
  return null;
}
