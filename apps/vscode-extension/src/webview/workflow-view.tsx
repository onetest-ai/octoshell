/**
 * WorkflowView — the workflow entity panel.
 *
 * Left: a read-only diagram of the step graph. Right: a structured editor over the same data.
 * Every edit round-trips through `workflow:setMeta`, which rewrites ONLY the `export const meta`
 * literal in workflow.js — the script body is never touched from here. When the script cannot be
 * parsed the editor is withheld and only the error and "Open script" remain: we must never
 * overwrite meta we could not read.
 */

import { useCallback, useEffect, useState } from "react";
import { Field } from "./field.js";
import { WorkflowDiagram } from "./workflow-diagram.js";
import type { RpcClient } from "./rpc-client.js";
import type { RpcResultOf } from "../protocol/index.js";
import type { WorkflowPhase, WorkflowStep } from "@octoshell/board";

type WorkflowData = RpcResultOf<"workflow:get">;

interface Props {
  id: string;
  rpc: RpcClient;
}

const inputClass = "flex-1 bg-input text-fg-input border border-border rounded px-2 py-1 text-sm";

export function WorkflowView({ id, rpc }: Props): JSX.Element {
  const [data, setData] = useState<WorkflowData>(null);
  const [error, setError] = useState<string | null>(null);

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

  /** Persist a whole new phase list, then reload from the host (disk is authoritative). */
  const savePhases = useCallback(
    async (phases: WorkflowPhase[]) => {
      if (!data) return;
      setError(null);
      try {
        await rpc.call("workflow:setMeta", {
          workflowId: id,
          meta: { name: data.name, description: data.description, phases },
        });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data, id, rpc, load],
  );

  const patchStep = useCallback(
    (phaseIndex: number, stepIndex: number, patch: Partial<WorkflowStep>) => {
      if (!data) return;
      const phases = data.phases.map((p, pi) =>
        pi !== phaseIndex
          ? p
          : { ...p, steps: p.steps.map((s, si) => (si !== stepIndex ? s : { ...s, ...patch })) },
      );
      void savePhases(phases);
    },
    [data, savePhases],
  );

  const addStep = useCallback(
    (phaseIndex: number) => {
      if (!data) return;
      const phase = data.phases[phaseIndex];
      if (!phase) return;
      const taken = new Set(data.phases.flatMap((p) => p.steps.map((s) => s.id)));
      let n = taken.size + 1;
      while (taken.has(`s${n}`)) n++;
      const step: WorkflowStep = { id: `s${n}`, agent: "claude", label: "New step" };
      void savePhases(data.phases.map((p, pi) => (pi !== phaseIndex ? p : { ...p, steps: [...p.steps, step] })));
    },
    [data, savePhases],
  );

  const removeStep = useCallback(
    (phaseIndex: number, stepIndex: number) => {
      if (!data) return;
      void savePhases(
        data.phases.map((p, pi) => (pi !== phaseIndex ? p : { ...p, steps: p.steps.filter((_, si) => si !== stepIndex) })),
      );
    },
    [data, savePhases],
  );

  const addPhase = useCallback(() => {
    if (!data) return;
    void savePhases([...data.phases, { title: `Phase ${data.phases.length + 1}`, steps: [] }]);
  }, [data, savePhases]);

  const saveDescription = useCallback(
    async (value: string) => {
      if (!data) return;
      setError(null);
      try {
        // Description lives in the script's meta — persist it the same way as step edits.
        await rpc.call("workflow:setMeta", {
          workflowId: id,
          meta: { name: data.name, description: value, phases: data.phases },
        });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data, id, rpc, load],
  );

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

      {error ? <div className="text-sm text-status-error">{error}</div> : null}

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
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <section>
            <h2 className="text-sm uppercase text-fg-muted mb-2">Diagram</h2>
            <WorkflowDiagram phases={data.phases} />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm uppercase text-fg-muted">Steps</h2>
            {data.phases.map((phase, pi) => (
              <div key={`${phase.title}-${pi}`} className="border border-border rounded p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{phase.title}</span>
                  <button
                    type="button"
                    className="ml-auto text-xs border border-border rounded px-2 py-0.5"
                    onClick={() => addStep(pi)}
                  >
                    Add step
                  </button>
                </div>
                {phase.steps.map((step, si) => (
                  <div key={step.id} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs text-fg-muted">{step.id}</span>
                    <input
                      aria-label={`Step ${step.id} label`}
                      className={inputClass}
                      defaultValue={step.label}
                      onBlur={(e) => patchStep(pi, si, { label: e.target.value })}
                    />
                    <input
                      aria-label={`Step ${step.id} agent`}
                      className={inputClass}
                      defaultValue={step.agent}
                      onBlur={(e) => patchStep(pi, si, { agent: e.target.value })}
                    />
                    <input
                      aria-label={`Step ${step.id} parallel group`}
                      title="Parallel group id — steps sharing one run concurrently. Leave blank to run sequentially (the default; use only for read-only steps)."
                      className="w-20 bg-input text-fg-input border border-border rounded px-2 py-1 text-sm"
                      placeholder="group"
                      defaultValue={step.parallel ?? ""}
                      onBlur={(e) => patchStep(pi, si, { parallel: e.target.value || undefined })}
                    />
                    <input
                      aria-label={`Step ${step.id} depends on`}
                      title="Depends-on: comma-separated step ids that must finish first. Chain writers linearly (each on the one before it) so the diagram shows the real sequence."
                      className="w-24 bg-input text-fg-input border border-border rounded px-2 py-1 text-sm"
                      placeholder="after…"
                      defaultValue={(step.dependsOn ?? []).join(", ")}
                      onBlur={(e) => {
                        const ids = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                        patchStep(pi, si, { dependsOn: ids.length ? ids : undefined });
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Remove step ${step.id}`}
                      className="codicon codicon-trash text-fg-muted"
                      onClick={() => removeStep(pi, si)}
                    />
                  </div>
                ))}
              </div>
            ))}
            <button type="button" className="text-xs border border-border rounded px-2 py-1" onClick={addPhase}>
              Add phase
            </button>
          </section>
        </div>
      )}

      <Field label="Description" value={data.description} onSave={(v) => void saveDescription(v)} />
    </div>
  );
}
