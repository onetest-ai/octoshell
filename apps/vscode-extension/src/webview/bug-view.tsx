import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "./status-pill.js";
import { Field } from "./field.js";
import { ENTITY_STATUS_OPTIONS } from "./entity-status.js";
import type { RpcClient } from "./rpc-client.js";

interface Bug {
  id: string;
  campaignId: string | null;
  missionId: string | null;
  title: string;
  status: string;
  severity: string;
  description: string;
  stepsToReproduce: string;
  expected: string;
  actual: string;
  rca: string;
  environment: string;
}

const SEVERITIES = ["blocker", "critical", "major", "minor", "trivial"] as const;
type Severity = (typeof SEVERITIES)[number];
type BugField = "description" | "stepsToReproduce" | "expected" | "actual" | "rca" | "environment";

export function BugView({ id, rpc }: { id: string; rpc: RpcClient }): JSX.Element {
  const [bug, setBug] = useState<Bug | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBug(await rpc.call("bug:get", { bugId: id }));
    setLoaded(true);
  }, [id, rpc]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { bugId?: string };
      if (e.bugId === id) void load();
    });
    return off;
  }, [id, rpc, load]);

  const save = useCallback(async (field: BugField, value: string) => {
    setError(null);
    try {
      await rpc.call("bug:update", { bugId: id, [field]: value });
      await load();
    } catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const saveSeverity = useCallback(async (value: Severity) => {
    setError(null);
    try { await rpc.call("bug:update", { bugId: id, severity: value }); await load(); }
    catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const saveStatus = useCallback(async (value: string) => {
    setError(null);
    try { await rpc.call("bug:setStatus", { bugId: id, status: value }); await load(); }
    catch (err) { setError((err as Error).message); }
  }, [id, rpc, load]);

  const b = bug;
  if (loaded && !b) return <div className="p-4 text-fg-muted">Bug not found.</div>;

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{b?.title ?? "…"}</h1>
            {b ? <StatusPill status={b.status} /> : null}
          </div>
          <div className="text-sm text-fg-muted">{b?.missionId ? `mission: ${b.missionId}` : b?.campaignId ? `campaign: ${b.campaignId}` : ""}</div>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <label htmlFor="bug-status" className="w-20 shrink-0 text-sm uppercase text-fg-muted">Status</label>
        <select
          id="bug-status"
          aria-label="Status"
          value={b?.status ?? "draft"}
          onChange={(e) => void saveStatus(e.target.value)}
          className="bg-input text-fg-input border border-border rounded-sm px-2 py-1"
        >
          {ENTITY_STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="bug-severity" className="w-20 shrink-0 text-sm uppercase text-fg-muted">Severity</label>
        <select
          id="bug-severity"
          aria-label="Severity"
          value={b?.severity ?? "major"}
          onChange={(e) => void saveSeverity(e.target.value as Severity)}
          className="bg-input text-fg-input border border-border rounded-sm px-2 py-1"
        >
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <Field label="Description" value={b?.description ?? ""} onSave={(v) => void save("description", v)} />
      <Field label="Steps to Reproduce" value={b?.stepsToReproduce ?? ""} onSave={(v) => void save("stepsToReproduce", v)} />
      <Field label="Expected" value={b?.expected ?? ""} onSave={(v) => void save("expected", v)} />
      <Field label="Actual" value={b?.actual ?? ""} onSave={(v) => void save("actual", v)} />
      <Field label="RCA" value={b?.rca ?? ""} onSave={(v) => void save("rca", v)} />
      <Field label="Environment" value={b?.environment ?? ""} onSave={(v) => void save("environment", v)} />

      {error && <div className="text-sm text-status-error">{error}</div>}
    </div>
  );
}
