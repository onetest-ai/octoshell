import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "./status-pill.js";
import { Field } from "./field.js";
import { ChecklistField } from "./checklist-field.js";
import { NotesBlock } from "./notes-block.js";
import { ENTITY_STATUS_OPTIONS } from "./entity-status.js";
import type { RpcClient } from "./rpc-client.js";
import type { RpcResultOf } from "../protocol/index.js";

interface Props {
  id: string;
  rpc: RpcClient;
  onOpenMission: (missionId: string) => void;
  onOpenBug: (bugId: string) => void;
  onDeleteMission: (missionId: string) => void;
  onNewMission: () => void;
  onOpenDoc: (relPath: string) => void;
  onAddLink: () => void;
  onAttachFile: () => void;
  onOpenFile: (path: string) => void;
}

type CampaignData = RpcResultOf<"campaign:get">;
type Missions = RpcResultOf<"mission:list">;
type Bugs = RpcResultOf<"bug:list">;
type CampaignDocs = RpcResultOf<"campaign:docs">;
type SyncResult = RpcResultOf<"campaign:missions:sync">;

export function CampaignView({ id, rpc, onOpenMission, onOpenBug, onDeleteMission, onNewMission, onOpenDoc, onAddLink, onAttachFile, onOpenFile }: Props): JSX.Element {
  const [data, setData] = useState<CampaignData | null>(null);
  const [missions, setMissions] = useState<Missions>([]);
  const [bugs, setBugs] = useState<Bugs>([]);
  const [docs, setDocs] = useState<CampaignDocs>({ files: [], attachedFiles: [], links: [] });
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<SyncResult["proposals"] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setData(await rpc.call("campaign:get", { campaignId: id }));
    setMissions((await rpc.call("mission:list", { campaignId: id })) ?? []);
    // Self-heal the bug list from the board (mirrors the missions auto-sync) so board-added bugs
    // surface even if the file watcher didn't fire, then load the reconciled entities.
    await rpc.call("bug:sync", { campaignId: id });
    setBugs((await rpc.call("bug:list", { campaignId: id })) ?? []);
    setDocs(await rpc.call("campaign:docs", { campaignId: id }));
    // Auto-surface the board's missions: parse campaign.md's ## Missions and show any not-yet-created
    // ones as proposals, so the agent's board work is visible on load (and on file-watch refresh).
    const boardSync = await rpc.call("campaign:missions:sync", { campaignId: id });
    const boardProposals = boardSync?.proposals ?? [];
    if (boardProposals.some((p) => !p.exists)) {
      setProposals(boardProposals);
      setPicked((prev) => Object.fromEntries(boardProposals.filter((p) => !p.exists).map((p) => [p.title, prev[p.title] ?? true])));
    } else {
      setProposals(null);
    }
  }, [id, rpc]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { campaignId?: string };
      if (e.campaignId === id) void load();
    });
    return off;
  }, [id, rpc, load]);

  const save = useCallback(
    async (field: "target" | "acceptanceCriteria" | "description" | "notes", value: string) => {
      setError(null);
      try {
        await rpc.call("campaign:update", { campaignId: id, [field]: value });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [id, rpc, load],
  );

  const saveStatus = useCallback(
    async (value: string) => {
      setError(null);
      try {
        await rpc.call("campaign:setStatus", { campaignId: id, status: value });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [id, rpc, load],
  );

  const removeLink = useCallback(
    async (target: string) => {
      setError(null);
      try {
        await rpc.call("campaign:docs:removeLink", { campaignId: id, target });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [id, rpc, load],
  );

  const sync = useCallback(async () => {
    setError(null);
    try {
      const r = await rpc.call("campaign:missions:sync", { campaignId: id });
      setProposals(r.proposals);
      setPicked(Object.fromEntries(r.proposals.filter((p) => !p.exists).map((p) => [p.title, true])));
    } catch (err) { setError((err as Error).message); }
  }, [id, rpc]);

  const createSelected = useCallback(async () => {
    setError(null);
    const missionsToCreate = (proposals ?? []).filter((p) => !p.exists && picked[p.title]).map((p) => ({ title: p.title, description: p.description }));
    if (!missionsToCreate.length) return;
    try {
      await rpc.call("campaign:missions:create", { campaignId: id, missions: missionsToCreate });
      setProposals(null);
      await load();
    } catch (err) { setError((err as Error).message); }
  }, [id, rpc, proposals, picked, load]);

  const c = data?.campaign;
  const counts = data?.summary?.counts ?? {};
  const countLine = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ");

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{c?.name ?? "…"}</h1>
            {data?.summary?.rollupStatus ? <StatusPill status={data.summary.rollupStatus} /> : null}
          </div>
          <div className="text-sm text-fg-muted">{countLine || "no missions"}</div>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <label htmlFor="campaign-status" className="w-20 shrink-0 text-sm uppercase text-fg-muted">Status</label>
        <select
          id="campaign-status"
          aria-label="Status"
          value={c?.status ?? "draft"}
          onChange={(e) => void saveStatus(e.target.value)}
          className="bg-input text-fg-input border border-border rounded-sm px-2 py-1"
        >
          {ENTITY_STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <Field label="Target" value={c?.target ?? ""} onSave={(v) => void save("target", v)} />
      <Field label="Description" value={c?.description ?? ""} onSave={(v) => void save("description", v)} />
      <ChecklistField label="Acceptance Criteria" value={c?.acceptanceCriteria ?? ""} onSave={(v) => void save("acceptanceCriteria", v)} />
      <NotesBlock notes={c?.notes} onSave={(v) => void save("notes", v)} />

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
          <div className="text-sm text-fg-muted">No documents — supporting files/links for this campaign.</div>
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
          <h2 className="text-sm uppercase text-fg-muted">Missions</h2>
          <div className="flex items-center gap-3">
            <button onClick={() => void sync()} aria-label="Sync missions from board" title="Sync missions from board">
              <span className="codicon codicon-sync" aria-hidden="true" />
            </button>
            <button onClick={onNewMission} aria-label="New mission" title="New mission">
              <span className="codicon codicon-add" aria-hidden="true" />
            </button>
          </div>
        </div>
        {missions.length === 0 ? (
          <div className="text-sm text-fg-muted">No missions yet.</div>
        ) : (
          <div className="border border-border rounded overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border text-fg-muted text-xs uppercase tracking-wide">
              <span>Mission</span>
              <span>Status</span>
            </div>
            {missions.map((m) => (
              <div
                key={m.id}
                className="group flex items-center gap-3 px-2 py-1.5 border-t border-border first:border-t-0 hover:bg-list-hover"
              >
                <button onClick={() => onOpenMission(m.id)} className="flex-1 min-w-0 text-left truncate">{m.title}</button>
                <StatusPill status={m.status} className="shrink-0" />
                <button
                  onClick={() => onDeleteMission(m.id)}
                  aria-label="Delete mission"
                  title="Delete mission"
                  className="shrink-0 text-fg-muted opacity-0 group-hover:opacity-100 hover:text-fg transition-opacity duration-fast"
                >
                  <span className="codicon codicon-close" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {proposals !== null && (
          proposals.length === 0 ? (
            <div className="mt-2 text-sm text-fg-muted">No missions found in campaign.md (## Missions) yet.</div>
          ) : (
            <div className="mt-2 space-y-1">
              {proposals.map((p) => (
                <label key={p.title} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={p.exists}
                    checked={p.exists ? false : !!picked[p.title]}
                    onChange={(e) => setPicked((s) => ({ ...s, [p.title]: e.target.checked }))}
                  />
                  <span className={p.exists ? "text-fg-muted" : ""}>
                    <span>{p.title}</span>{p.description ? ` — ${p.description}` : ""}{p.exists ? " (already created)" : ""}
                  </span>
                </label>
              ))}
              <button onClick={() => void createSelected()}>Create selected</button>
            </div>
          )
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
