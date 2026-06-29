// apps/vscode-extension/src/protocol/ui-messages.ts
import { z } from "zod";

export const uiMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("openMission"), id: z.string() }),
  z.object({ type: z.literal("openTask"), id: z.string() }),
  z.object({ type: z.literal("newMissionInCampaign"), id: z.string() }),
  z.object({ type: z.literal("newTaskInMission"), id: z.string() }),
  z.object({ type: z.literal("openCampaignDoc"), campaignId: z.string(), relPath: z.string() }),
  z.object({ type: z.literal("openMissionDoc"), missionId: z.string(), relPath: z.string() }),
  z.object({ type: z.literal("addCampaignLink"), campaignId: z.string() }),
  z.object({ type: z.literal("addMissionLink"), missionId: z.string() }),
  z.object({ type: z.literal("attachCampaignFile"), campaignId: z.string() }),
  z.object({ type: z.literal("attachMissionFile"), missionId: z.string() }),
  z.object({ type: z.literal("deleteMission"), missionId: z.string() }),
  z.object({ type: z.literal("deleteTask"), taskId: z.string() }),
  z.object({ type: z.literal("openBug"), id: z.string() }),
  z.object({ type: z.literal("newBugInCampaign"), id: z.string() }),
  z.object({ type: z.literal("newBugInMission"), id: z.string() }),
  z.object({ type: z.literal("deleteBug"), bugId: z.string() }),
  z.object({ type: z.literal("openFile"), path: z.string() }),
]);
export type UiMessage = z.infer<typeof uiMessage>;
export type UiMessageType = UiMessage["type"];

/** Handlers a panel provides. Each panel implements only the subset it cares about;
 *  a message whose handler is absent is silently ignored — entity panels only handle the subset they need. */
export type UiActions = {
  [T in UiMessageType]?: (msg: Extract<UiMessage, { type: T }>) => void;
};

/** Returns true if `raw` was a structurally-valid UI message (dispatched if a handler existed),
 *  false otherwise (a non-UI message OR a malformed-but-tagged one). Never throws — uses safeParse. */
export function routeUiMessage(raw: unknown, actions: UiActions): boolean {
  const parsed = uiMessage.safeParse(raw);
  if (!parsed.success) return false;
  const msg = parsed.data;
  const handler = actions[msg.type] as ((m: UiMessage) => void) | undefined;
  if (handler) handler(msg);
  return true;
}
