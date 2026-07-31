import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "./status-pill.js";
import { Field } from "./field.js";
import { ChecklistField } from "./checklist-field.js";
import { ENTITY_STATUS_OPTIONS } from "./entity-status.js";
import { EstimateBlock } from "./estimate-block.js";
import { NotesBlock } from "./notes-block.js";
import type { RpcClient } from "./rpc-client.js";

interface Task { id: string; missionId: string; name: string; status: string; description: string; acceptanceCriteria: string; tokenomics?: Record<string, unknown>; notes?: string }

export function TaskView({ id, rpc }: { id: string; rpc: RpcClient }): JSX.Element {
  const [task, setTask] = useState<Task | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setTask(await rpc.call("task:get", { taskId: id }));
    setLoaded(true);
  }, [id, rpc]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { taskId?: string };
      if (e.taskId === id) void load();
    });
    return off;
  }, [id, rpc, load]);

  const save = useCallback(async (field: "acceptanceCriteria" | "description" | "notes", value: string) => {
    setError(null);
    try {
      await rpc.call("task:update", { taskId: id, [field]: value });
      await load();
    } catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const saveStatus = useCallback(async (value: string) => {
    setError(null);
    try { await rpc.call("task:setStatus", { taskId: id, status: value }); await load(); }
    catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const t = task;
  if (loaded && !t) return <div className="p-4 text-fg-muted">Task not found.</div>;

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{t?.name ?? "…"}</h1>
            {t ? <StatusPill status={t.status} /> : null}
          </div>
          <div className="text-sm text-fg-muted">mission: {t?.missionId}</div>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <label htmlFor="task-status" className="w-20 shrink-0 text-sm uppercase text-fg-muted">Status</label>
        <select
          id="task-status"
          aria-label="Status"
          value={t?.status ?? "draft"}
          onChange={(e) => void saveStatus(e.target.value)}
          className="bg-input text-fg-input border border-border rounded-sm px-2 py-1"
        >
          {ENTITY_STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <Field label="Description" value={t?.description ?? ""} onSave={(v) => void save("description", v)} />
      <ChecklistField label="Acceptance Criteria" value={t?.acceptanceCriteria ?? ""} onSave={(v) => void save("acceptanceCriteria", v)} />

      <EstimateBlock tokenomics={t?.tokenomics} />
      <NotesBlock notes={t?.notes} onSave={(v) => void save("notes", v)} />

      {error && <div className="text-sm text-status-error">{error}</div>}
    </div>
  );
}
