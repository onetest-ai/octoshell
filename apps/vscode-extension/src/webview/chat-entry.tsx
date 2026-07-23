import "./index.css";
import "@vscode-elements/elements/dist/bundled";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRpcClient, type RpcClient } from "./rpc-client.js";
import { createOctoshellShim } from "./octoshell-shim.js";
import { initWebviewTheme } from "./theme.js";
import { CampaignView } from "./campaign-view.js";
import { MissionView } from "./mission-view.js";
import { TaskView } from "./task-view.js";
import { BugView } from "./bug-view.js";
import { WorkflowView } from "./workflow-view.js";
import { TokenomicsView } from "./tokenomics-view.js";

declare global {
  interface Window {
    octoshell: ReturnType<typeof createOctoshellShim>;
  }
  function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
}

const vscodeApi = acquireVsCodeApi();
const rpc: RpcClient = createRpcClient(vscodeApi);
window.octoshell = createOctoshellShim(rpc);
initWebviewTheme();

type Bound =
  | { kind: "campaign"; id: string }
  | { kind: "mission"; id: string }
  | { kind: "task"; id: string }
  | { kind: "bug"; id: string }
  | { kind: "workflow"; id: string }
  | { kind: "tokenomics" }
  | { kind: "none" };

export function resolveBound(
  m: { type?: string; kind?: string; id?: string } | undefined,
): Bound {
  if (m?.kind === "campaign" && m.id) return { kind: "campaign", id: m.id };
  if (m?.kind === "mission" && m.id) return { kind: "mission", id: m.id };
  if (m?.kind === "task" && m.id) return { kind: "task", id: m.id };
  if (m?.kind === "bug" && m.id) return { kind: "bug", id: m.id };
  if (m?.kind === "workflow" && m.id) return { kind: "workflow", id: m.id };
  // Workspace-wide, so it carries no entity id.
  if (m?.kind === "tokenomics") return { kind: "tokenomics" };
  return { kind: "none" };
}

function Root(): JSX.Element {
  const restored = vscodeApi.getState() as { kind?: string; id?: string } | undefined;
  const [bound, setBound] = useState<Bound>(() => resolveBound(restored ? { type: "bind", ...restored } : undefined));

  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const m = e.data as { type?: string; kind?: string; id?: string };
      if (m?.type !== "bind") return;
      const next = resolveBound(m);
      setBound(next);
      if (next.kind !== "none") {
        vscodeApi.setState({ kind: next.kind, id: "id" in next ? next.id : undefined });
      }
    };
    window.addEventListener("message", onMsg);
    vscodeApi.postMessage({ type: "webview-ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  if (bound.kind === "tokenomics") return <TokenomicsView rpc={rpc} />;
  if (bound.kind === "campaign") {
    return (
      <CampaignView
        id={bound.id}
        rpc={rpc}
        onOpenMission={(mid) => vscodeApi.postMessage({ type: "openMission", id: mid })}
        onOpenBug={(bid) => vscodeApi.postMessage({ type: "openBug", id: bid })}
        onDeleteMission={(mid) => vscodeApi.postMessage({ type: "deleteMission", missionId: mid })}
        onNewMission={() => vscodeApi.postMessage({ type: "newMissionInCampaign", id: bound.id })}
        onOpenDoc={(relPath) => vscodeApi.postMessage({ type: "openCampaignDoc", campaignId: bound.id, relPath })}
        onAddLink={() => vscodeApi.postMessage({ type: "addCampaignLink", campaignId: bound.id })}
        onAttachFile={() => vscodeApi.postMessage({ type: "attachCampaignFile", campaignId: bound.id })}
        onOpenFile={(path) => vscodeApi.postMessage({ type: "openFile", path })}
      />
    );
  }
  if (bound.kind === "mission") {
    return (
      <MissionView
        id={bound.id}
        rpc={rpc}
        onOpenTask={(tid) => vscodeApi.postMessage({ type: "openTask", id: tid })}
        onOpenBug={(bid) => vscodeApi.postMessage({ type: "openBug", id: bid })}
        onDeleteTask={(tid) => vscodeApi.postMessage({ type: "deleteTask", taskId: tid })}
        onNewTask={() => vscodeApi.postMessage({ type: "newTaskInMission", id: bound.id })}
        onOpenDoc={(relPath) => vscodeApi.postMessage({ type: "openMissionDoc", missionId: bound.id, relPath })}
        onAddLink={() => vscodeApi.postMessage({ type: "addMissionLink", missionId: bound.id })}
        onAttachFile={() => vscodeApi.postMessage({ type: "attachMissionFile", missionId: bound.id })}
        onOpenFile={(path) => vscodeApi.postMessage({ type: "openFile", path })}
      />
    );
  }
  if (bound.kind === "task") {
    return <TaskView id={bound.id} rpc={rpc} />;
  }
  if (bound.kind === "bug") {
    return <BugView id={bound.id} rpc={rpc} />;
  }
  if (bound.kind === "workflow") {
    return <WorkflowView id={bound.id} rpc={rpc} />;
  }
  return <div className="p-4 text-fg-muted">No board entity bound.</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
