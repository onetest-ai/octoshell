/**
 * WorkflowView — the workflow entity panel.
 *
 * Read-only. The script is the source of truth: `meta` is generated from the body by
 * `sync-meta.js`, so the board draws a workflow and never writes one.
 */

import { useCallback, useEffect, useState } from "react";
import { WorkflowDiagram } from "./workflow-diagram.js";
import type { RpcClient } from "./rpc-client.js";
import type { RpcResultOf } from "../protocol/index.js";

type WorkflowData = RpcResultOf<"workflow:get">;

interface Props {
  id: string;
  rpc: RpcClient;
}

export function WorkflowView({ id, rpc }: Props): JSX.Element {
  const [data, setData] = useState<WorkflowData>(null);

  const load = useCallback(async () => {
    setData(await rpc.call("workflow:get", { workflowId: id }));
  }, [id, rpc]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { workflowId?: string };
      if (e.workflowId === id) void load();
    });
    return off;
  }, [id, rpc, load]);

  if (!data) return <div className="p-4 text-fg-muted">Loading…</div>;

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-center gap-2">
        <span className="codicon codicon-circuit-board" aria-hidden="true" />
        <h1 className="text-lg">{data.name}</h1>
        {data.lastRunStatus ? (
          <span className="text-xs text-fg-muted">last run: {data.lastRunStatus}</span>
        ) : null}
        <button
          type="button"
          className="ml-auto text-sm border border-border rounded px-2 py-1"
          onClick={() => void rpc.call("workflow:openScript", { workflowId: id })}
        >
          Open script
        </button>
      </header>

      {data.parseError ? (
        <section className="border border-border rounded p-3 space-y-2">
          <h2 className="text-sm uppercase text-fg-muted">Script could not be read</h2>
          <p className="text-sm">{data.parseError}</p>
          <p className="text-sm text-fg-muted">
            Fix <code>{data.scriptPath}</code> so its <code>export const meta</code> is a pure object
            literal, then this panel will render the diagram again.
          </p>
        </section>
      ) : (
        <section>
          <h2 className="text-sm uppercase text-fg-muted mb-2">Diagram</h2>
          <WorkflowDiagram phases={data.phases} />
        </section>
      )}

      <section className="space-y-1">
        <h2 className="text-sm uppercase text-fg-muted">Description</h2>
        <p className="text-sm">{data.description}</p>
      </section>
    </div>
  );
}
