// The test-case panel (0.1.1 T1.3): one TC as a read view plus a status dropdown. Everything comes from `tests:get`;
// a pick goes through `tests:setStatus` carrying only the path, the new status and the status and last run THIS panel
// showed (never file text), so the host can refuse when an agent wrote a newer status since. Editing the body or any
// other field happens in the source file. Colours are theme-token classes only; status is never colour alone.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./rpc-client.js";
import type { SetTestStatusResult, TestCaseDetail } from "../protocol/index.js";
import { Markdown } from "./markdown.js";
import { TestStatusBadge } from "./tests-ui.js";

type Settable = "draft" | "ready" | "pass" | "fail" | "blocked";
const SETTABLE: readonly Settable[] = ["draft", "ready", "pass", "fail", "blocked"];

const LEGACY_NOTE = "legacy test case: kind and mission not recorded; set-test-status.js <file> --migrate adds them";
const STALE_NOTICE = "The status changed outside the panel and was not saved. The panel now shows the current status.";
const PICK_HINT = "A pass, fail or blocked pick records today's date and replaces any earlier evidence link.";

const WHY_DISABLED: Record<Extract<TestCaseDetail["writable"], { ok: false }>["reason"], string> = {
  "no-frontmatter": "This file has no frontmatter, so its status cannot be set here: run set-test-status.js <file> --migrate.",
  unparseable: "The frontmatter could not be parsed, so its status is not written from here. Fix it in the source file.",
  symlink: "This file or its folder is a symlink; its status is never written from here.",
  "too-large": "This file is too large to edit from here.",
};

type Notice = { kind: "stale" | "refused"; text: string };

const link = "text-fg-link underline";

export function TestCaseView(
  { path, rpc, onOpenMission, onOpenTestFile, onOpenTestEvidence }:
  {
    path: string;
    rpc: RpcClient;
    onOpenMission: (missionId: string) => void;
    onOpenTestFile: (path: string) => void;
    onOpenTestEvidence: (path: string) => void;
  },
): JSX.Element {
  // undefined: not loaded yet; null: the TC is gone (or the host's guard rejected the path).
  const [detail, setDetail] = useState<TestCaseDetail | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const n = ++latest.current;
    const got = (await rpc.call("tests:get", { path })) ?? null;
    if (n === latest.current) setDetail(got);
  }, [path, rpc]);

  useEffect(() => {
    void load();
    // Every refresh the host sends re-reads the TC: disk is the truth, and the notice below is not touched by it.
    return rpc.onSpineEvent(() => { void load(); });
  }, [rpc, load]);

  const pick = useCallback(async (next: Settable) => {
    if (!detail || busy) return;
    const { status, lastRun } = detail.tc;
    setNotice(null); // the notice lives until the user's next pick
    setBusy(true);
    try {
      const res: SetTestStatusResult = await rpc.call("tests:setStatus", {
        path,
        status: next,
        base: { status, lastRun: lastRun ? { date: lastRun.date, ...(lastRun.evidence ? { evidence: lastRun.evidence } : {}) } : null },
      });
      if (!res.ok) setNotice(res.reason === "stale" ? { kind: "stale", text: STALE_NOTICE } : { kind: "refused", text: res.message });
    } catch (err) {
      setNotice({ kind: "refused", text: (err as Error).message });
    }
    try { await load(); } finally { setBusy(false); }
  }, [detail, busy, path, rpc, load]);

  if (detail === undefined) return <div className="p-4 text-fg-muted">Loading…</div>;
  if (detail === null) return <div className="p-4 text-fg-muted">This test case no longer exists</div>;

  const { tc, writable } = detail;
  const disabledReason = writable.ok ? null : WHY_DISABLED[writable.reason];
  const describedBy = disabledReason ? "tc-status-reason" : "tc-status-hint";

  return (
    <div className="p-4 space-y-4">
      <header data-testid="tc-header" className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold flex items-baseline gap-2">
            <span className="font-mono">{tc.id}</span>
            <span>{tc.title}</span>
          </h1>
          <TestStatusBadge status={tc.status} />
        </div>
        <div data-testid="tc-kind" className="text-sm text-fg-muted">
          <span className="uppercase">Kind</span> <span className="text-fg">{tc.kind ?? "none"}</span>
        </div>
        <div data-testid="tc-last-run" className="text-sm text-fg-muted">
          <span className="uppercase">Last run</span> <LastRun detail={detail} onOpenEvidence={() => onOpenTestEvidence(path)} />
        </div>
      </header>

      <div>
        <div className="flex items-center gap-2">
          <label htmlFor="tc-status" className="w-20 shrink-0 text-sm uppercase text-fg-muted">Status</label>
          <select
            id="tc-status"
            aria-label="Status"
            aria-describedby={describedBy}
            value={tc.status}
            disabled={busy || !writable.ok}
            onChange={(e) => void pick(e.target.value as Settable)}
            className="bg-input text-fg-input border border-border rounded-sm px-2 py-1"
          >
            {tc.status === "unknown" ? <option value="unknown" disabled>unknown</option> : null}
            {SETTABLE.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {disabledReason ? (
          <p id="tc-status-reason" className="mt-1 text-xs text-fg-muted">{disabledReason}</p>
        ) : (
          <p id="tc-status-hint" className="mt-1 text-xs text-fg-muted">{PICK_HINT}</p>
        )}
        {notice ? (
          <div role="status" data-testid="tc-notice" className="mt-2 flex items-center gap-2 text-sm text-status-warning">
            <span className="codicon codicon-warning" aria-hidden="true" />
            <span>{notice.text}</span>
          </div>
        ) : null}
        {detail.legacy ? (
          <p data-testid="tc-legacy-note" className="mt-2 text-sm text-fg-muted">{LEGACY_NOTE}</p>
        ) : null}
      </div>

      <section aria-labelledby="tc-criteria-h">
        <h2 id="tc-criteria-h" className="text-sm uppercase text-fg-muted mb-2">Covered criteria</h2>
        {detail.mission === null ? <p className="text-sm text-status-warning">mission {tc.mission} not found</p> : null}
        {detail.criteria.length === 0 ? (
          <p className="text-sm text-fg-muted">none listed</p>
        ) : (
          <ul className="border border-border rounded overflow-hidden">
            {detail.criteria.map((c) => (
              <li key={c.ac} data-testid="tc-criterion" className="flex items-baseline gap-3 px-2 py-1.5 border-t border-border first:border-t-0">
                {detail.missionId !== null && c.text !== null ? (
                  <a
                    href="#"
                    data-testid="tc-criterion-id"
                    className={`font-mono shrink-0 ${link}`}
                    onClick={(e) => { e.preventDefault(); onOpenMission(detail.missionId!); }}
                  >{c.ac}</a>
                ) : (
                  <span data-testid="tc-criterion-id" className="font-mono shrink-0">{c.ac}</span>
                )}
                {c.text !== null ? (
                  <span className="text-sm">{c.text}</span>
                ) : detail.mission !== null ? (
                  <span className="inline-flex items-center gap-1 text-sm text-status-warning">
                    <span className="codicon codicon-warning" aria-hidden="true" />
                    <span>not a criterion of {tc.mission}</span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tc-body-h">
        <div className="flex items-center justify-between mb-2">
          <h2 id="tc-body-h" className="text-sm uppercase text-fg-muted">Test case</h2>
          <button
            onClick={() => onOpenTestFile(path)}
            className="bg-btn-secondary hover:bg-btn-secondary-hover px-2 py-0.5 rounded-sm text-sm"
          >
            Open source file
          </button>
        </div>
        <div data-testid="tc-body" className="border border-border rounded px-3 py-2 text-sm break-words">
          {detail.body.kind === "markdown" ? (
            <Markdown>{detail.body.text}</Markdown>
          ) : detail.body.kind === "plain" ? (
            <pre className="whitespace-pre-wrap font-mono text-[0.9em]">{detail.body.text}</pre>
          ) : (
            <span className="text-fg-muted">too large to show; Open source file</span>
          )}
        </div>
      </section>
    </div>
  );
}

/** `never run`; the date with `no evidence`; the date with a link to the RUN file; or the date and the path marked `not found`. */
function LastRun({ detail, onOpenEvidence }: { detail: TestCaseDetail; onOpenEvidence: () => void }): JSX.Element {
  const run = detail.tc.lastRun;
  if (!run) return <span className="text-fg">never run</span>;
  const { evidence } = detail;
  return (
    <span className="text-fg">
      {run.date}
      {" "}
      {!evidence ? (
        <span className="text-fg-muted">no evidence</span>
      ) : evidence.exists ? (
        <a href="#" className={link} onClick={(e) => { e.preventDefault(); onOpenEvidence(); }}>{evidence.path}</a>
      ) : (
        <span className="text-fg-muted">{evidence.path} (not found)</span>
      )}
    </span>
  );
}
