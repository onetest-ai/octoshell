import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "./status-pill.js";
import { Field } from "./field.js";
import { ChecklistField } from "./checklist-field.js";
import { ENTITY_STATUS_OPTIONS } from "./entity-status.js";
import type { RpcClient } from "./rpc-client.js";

interface Mission { id: string; campaignId: string; title: string; status: string; description: string; acceptanceCriteria: string }
interface PersistedTask { id: string; missionId: string; name: string; status: string }
interface MissionBug { id: string; title: string; status: string; severity: string }
interface DocFile { name: string; kind: string; size: number; mtime: number }
interface DocLink { id: string; target: string; label?: string }

export function MissionView(
  { id, rpc, onOpenTask, onOpenBug, onNewTask, onDeleteTask, onOpenDoc, onAddLink, onAttachFile, onOpenFile }:
  {
    id: string; rpc: RpcClient;
    onOpenTask: (taskId: string) => void; onOpenBug: (bugId: string) => void; onNewTask: () => void;
    onDeleteTask: (taskId: string) => void;
    onOpenDoc: (relPath: string) => void; onAddLink: () => void; onAttachFile: () => void; onOpenFile: (path: string) => void;
  },
): JSX.Element {
  const [mission, setMission] = useState<Mission | null>(null);
  const [persistedTasks, setPersistedTasks] = useState<PersistedTask[]>([]);
  const [bugs, setBugs] = useState<MissionBug[]>([]);
  const [docs, setDocs] = useState<{ files: DocFile[]; attachedFiles: DocLink[]; links: DocLink[] }>({ files: [], attachedFiles: [], links: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMission(await rpc.call("mission:get", { missionId: id }));
    setPersistedTasks((await rpc.call("task:list", { missionId: id })) ?? []);
    // Self-heal the bug list from the board (mirrors the tasks sync) so board-added bugs surface.
    await rpc.call("bug:sync", { missionId: id });
    setBugs((await rpc.call("bug:list", { missionId: id })) ?? []);
    setDocs((await rpc.call("mission:docs", { missionId: id })) ?? { files: [], attachedFiles: [], links: [] });
    setLoaded(true);
  }, [id, rpc]);

  const removeLink = useCallback(async (target: string) => {
    setError(null);
    try {
      await rpc.call("mission:docs:removeLink", { missionId: id, target });
      await load();
    } catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { missionId?: string };
      if (e.missionId === id) void load();
    });
    return off;
  }, [id, rpc, load]);

  const save = useCallback(async (field: "acceptanceCriteria" | "description", value: string) => {
    setError(null);
    try {
      await rpc.call("mission:update", { missionId: id, [field]: value });
      await load();
    } catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const saveStatus = useCallback(async (value: string) => {
    setError(null);
    try { await rpc.call("mission:setStatus", { missionId: id, status: value }); await load(); }
    catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const syncTasks = useCallback(async () => {
    setError(null);
    try { await rpc.call("mission:syncTasks", { missionId: id }); await load(); }
    catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const m = mission;
  if (loaded && !m) return <div className="p-4 text-fg-muted">Mission not found.</div>;

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{m?.title ?? "…"}</h1>
            {m ? <StatusPill status={m.status} /> : null}
          </div>
          <div className="text-sm text-fg-muted">campaign: {m?.campaignId}</div>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <label htmlFor="mission-status" className="w-20 shrink-0 text-sm uppercase text-fg-muted">Status</label>
        <select
          id="mission-status"
          aria-label="Status"
          value={m?.status ?? "draft"}
          onChange={(e) => void saveStatus(e.target.value)}
          className="bg-input text-fg-input border border-border rounded-sm px-2 py-1"
        >
          {ENTITY_STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <Field label="Description" value={m?.description ?? ""} onSave={(v) => void save("description", v)} />
      <ChecklistField label="Acceptance Criteria" value={m?.acceptanceCriteria ?? ""} onSave={(v) => void save("acceptanceCriteria", v)} />

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm uppercase text-fg-muted">Documents</h2>
          <div className="flex items-center gap-3">
            <button onClick={onAttachFile} aria-label="Attach file" title="Attach file">
              <span className="codicon codicon-new-file" aria-hidden="true" />
            </button>
            <button onClick={onAddLink} aria-label="Attach link" title="Attach link">
              <span className="codicon codicon-link" aria-hidden="true" />
            </button>
          </div>
        </div>
        {docs.files.length + docs.attachedFiles.length + docs.links.length === 0 ? (
          <div className="text-sm text-fg-muted">No documents — supporting files/links for this mission.</div>
        ) : (
          <ul className="space-y-1">
            {docs.files.map((f) => (
              <li key={f.name}><button className="text-left w-full" onClick={() => onOpenDoc(f.name)}><span className="codicon codicon-file mr-1" aria-hidden="true" />{f.name}</button></li>
            ))}
            {docs.attachedFiles.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <button className="text-left flex-1" onClick={() => onOpenFile(f.target)}><span className="codicon codicon-file-symlink-file mr-1" aria-hidden="true" />{f.label || f.target}</button>
                <button onClick={() => void removeLink(f.target)} aria-label="Remove"><span className="codicon codicon-close" aria-hidden="true" /></button>
              </li>
            ))}
            {docs.links.map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <span className="flex-1"><span className="codicon codicon-link mr-1" aria-hidden="true" />{l.label || l.target}</span>
                <button onClick={() => void removeLink(l.target)} aria-label="Remove"><span className="codicon codicon-close" aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm uppercase text-fg-muted">Tasks</h2>
          <div className="flex items-center gap-3">
            <button onClick={() => void syncTasks()} aria-label="Sync tasks from board" title="Sync tasks from board">
              <span className="codicon codicon-sync" aria-hidden="true" />
            </button>
            <button onClick={onNewTask} aria-label="New task" title="New task">
              <span className="codicon codicon-add" aria-hidden="true" />
            </button>
          </div>
        </div>
        {persistedTasks.length === 0 ? (
          <div className="text-sm text-fg-muted">No tasks yet.</div>
        ) : (
          <div className="border border-border rounded overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border text-fg-muted text-xs uppercase tracking-wide">
              <span>Task</span>
              <span>Status</span>
            </div>
            {persistedTasks.map((t) => (
              <div
                key={t.id}
                className="group flex items-center gap-3 px-2 py-1.5 border-t border-border first:border-t-0 cursor-pointer hover:bg-list-hover"
                onDoubleClick={() => onOpenTask(t.id)}
                title="Double-click to open"
              >
                <span className="flex-1 min-w-0 truncate">{t.name}</span>
                <StatusPill status={t.status} className="shrink-0" />
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteTask(t.id); }}
                  aria-label="Delete task"
                  title="Delete task"
                  className="shrink-0 text-fg-muted opacity-0 group-hover:opacity-100 hover:text-fg transition-opacity duration-fast"
                >
                  <span className="codicon codicon-close" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase text-fg-muted mb-2">Bugs</h2>
        {bugs.length === 0 ? (
          <div className="text-sm text-fg-muted">No bugs yet.</div>
        ) : (
          <div className="border border-border rounded overflow-hidden">
            {bugs.map((b) => (
              <div
                key={b.id}
                className="group flex items-center gap-3 px-2 py-1.5 border-t border-border first:border-t-0 hover:bg-list-hover"
              >
                <span className="codicon codicon-bug shrink-0 text-fg-muted" aria-hidden="true" />
                <button onClick={() => onOpenBug(b.id)} className="flex-1 min-w-0 text-left truncate">{b.title}</button>
                <span className="shrink-0 text-xs text-fg-muted">{b.severity}</span>
                <StatusPill status={b.status} className="shrink-0" />
              </div>
            ))}
          </div>
        )}
      </section>


      {error && <div className="text-sm text-status-error">{error}</div>}
    </div>
  );
}
