import { useEffect, useState } from "react";
import type { RpcClient } from "./rpc-client.js";
import type { MissionRun, Report, TaskRun } from "@octoshell/tokenomics";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const int = (n: number): string => n.toLocaleString("en-US");
const mtok = (n: number): string => `${(n / 1e6).toFixed(1)}M`;

function tokenTotal(t: MissionRun["tokens"]): number {
  // `cacheCreate5m`/`1h` are a breakdown of `cacheCreate`, not extra tokens.
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

/** Cost is never a sizing input — sizes come from the authored estimate. */
function bySize(runs: MissionRun[]): { size: string; n: number; cost: number; days: number }[] {
  const order = ["XS", "S", "M", "L", "XL"];
  const acc = new Map<string, { n: number; cost: number; days: number }>();
  for (const r of runs) {
    const size = r.estimate.sizeTshirt ?? "—";
    const cur = acc.get(size) ?? { n: 0, cost: 0, days: 0 };
    cur.n += 1;
    cur.cost += r.costUsd;
    cur.days += r.estimate.effortDays ?? 0;
    acc.set(size, cur);
  }
  return [...acc.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([size, v]) => ({ size, ...v }));
}

function Tile({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div className="tok-tile">
      <div className="tok-tile-value">{value}</div>
      <div className="tok-tile-label">{label}</div>
    </div>
  );
}

function TaskRows({ tasks, missionCost }: { tasks: TaskRun[]; missionCost: number }): JSX.Element {
  return (
    <table className="tok-table">
      <thead>
        <tr>
          <th className="l">Task</th>
          <th>Size</th>
          <th>Effort d</th>
          <th className="l">Cost</th>
          <th>Share</th>
          <th>Turns</th>
          <th>Disp.</th>
          <th className="l">Attributed</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.taskId ?? "mission-level"} className={t.unmeasured ? "tok-dim" : undefined}>
            <td className="l">
              <strong>{t.taskId ?? "—"}</strong> {t.name}
            </td>
            <td>{t.estimate.sizeTshirt ?? "—"}</td>
            <td>{t.estimate.effortDays ?? "—"}</td>
            <td className="l">{usd(t.costUsd)}</td>
            <td>{missionCost > 0 ? `${t.costSharePct}%` : "—"}</td>
            <td>{int(t.turns)}</td>
            <td>{t.subagentDispatches}</td>
            {/* Whether the link was recorded or guessed — guessing stays visible. */}
            <td className="l">{t.unmeasured ? "not measured" : (t.attribution ?? "—")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TokenomicsView({ rpc }: { rpc: RpcClient }): JSX.Element {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("tokenomics:report", {})
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  if (error) return <div className="tok-root">Could not read tokenomics: {error}</div>;
  if (!report) return <div className="tok-root">Collecting…</div>;

  const attributed = report.runs.reduce((n, r) => n + r.costUsd, 0);
  const total = attributed + report.unattributed.costUsd;
  const tokens = report.runs.reduce((n, r) => n + tokenTotal(r.tokens), 0);
  const turns = report.runs.reduce((n, r) => n + r.turns, 0);
  const dispatches = report.runs.reduce((n, r) => n + r.subagentDispatches, 0);
  const unattrPct = total > 0 ? Math.round((100 * report.unattributed.costUsd) / total) : 0;
  const noEstimate = report.runs.filter((r) => r.estimate.effortDays === null);
  const retrospective = report.runs.filter((r) => r.estimate.estimatedRetrospectively);

  if (report.runs.length === 0) {
    return (
      <div className="tok-root">
        <h1>Tokenomics</h1>
        <p className="tok-sub">
          No measured missions yet. Cost is collected from agent transcripts and attributed by
          branch, or by the work log once a task’s status has been flipped.
        </p>
      </div>
    );
  }

  return (
    <div className="tok-root">
      <h1>Tokenomics</h1>
      <p className="tok-sub">
        Metered from {report.agentTool} transcripts. Token counts are canonical; dollars are
        recomputed from them under the cached price table
        {report.pricesFetchedAt ? ` (${report.pricesFetchedAt})` : ""} and are API-equivalent, not
        billed.
      </p>

      <div className="tok-tiles">
        <Tile value={usd(total)} label="Total metered cost" />
        <Tile value={String(report.runs.length)} label="Missions measured" />
        <Tile value={mtok(tokens)} label="Tokens (attributed)" />
        <Tile value={int(turns)} label="Turns" />
        <Tile value={String(dispatches)} label="Subagent dispatches" />
      </div>

      <h2>Missions</h2>
      <table className="tok-table">
        <thead>
          <tr>
            <th className="l">Mission</th>
            <th>Size</th>
            <th>Effort d</th>
            <th className="l">Cost</th>
            <th>Orch.</th>
            <th>Cache</th>
            <th>Turns</th>
            <th>Disp.</th>
          </tr>
        </thead>
        <tbody>
          {report.runs.map((r) => {
            const isOpen = open === r.missionId;
            return [
              <tr
                key={r.missionId}
                className="tok-clickable"
                onClick={() => setOpen(isOpen ? null : r.missionId)}
              >
                <td className="l">
                  {isOpen ? "▾" : "▸"} <strong>{r.missionTitle}</strong>
                </td>
                <td>{r.estimate.sizeTshirt ?? "—"}</td>
                <td>{r.estimate.effortDays ?? "—"}</td>
                <td className="l">{usd(r.costUsd)}</td>
                <td>{r.orchestratorCostPct}%</td>
                <td>{r.cacheReadSharePct}%</td>
                <td>{int(r.turns)}</td>
                <td>{r.subagentDispatches}</td>
              </tr>,
              isOpen ? (
                <tr key={`${r.missionId}:tasks`}>
                  <td colSpan={8} className="tok-nested">
                    <TaskRows tasks={r.tasks} missionCost={r.costUsd} />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>

      <h2>Cost by size</h2>
      <p className="tok-sub">
        Measured cost against authored effort. Sizes come from the rubric’s Effort bands, so this
        stays non-circular — cost is never a sizing input.
      </p>
      <table className="tok-table">
        <thead>
          <tr>
            <th className="l">Size</th>
            <th>Missions</th>
            <th className="l">Total</th>
            <th>Effort days</th>
            <th className="l">$ / effort-day</th>
          </tr>
        </thead>
        <tbody>
          {bySize(report.runs).map((row) => (
            <tr key={row.size}>
              <td className="l">
                <strong>{row.size}</strong>
              </td>
              <td>{row.n}</td>
              <td className="l">{usd(row.cost)}</td>
              <td>{row.days || "—"}</td>
              <td className="l">{row.days ? usd(row.cost / row.days) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Data quality</h2>
      <ul className="tok-findings">
        {noEstimate.length > 0 && (
          <li>
            <strong>{noEstimate.length} of {report.runs.length} missions have no authored effort.</strong>{" "}
            Effort is the sizing key and cannot be derived from transcripts — add a{" "}
            <code>## Tokenomics</code> block at planning time.
          </li>
        )}
        {retrospective.length > 0 && (
          <li>
            <strong>{retrospective.length} missions were estimated retrospectively.</strong> Their
            effort was reconstructed after the work shipped, so the cost-per-size figures inherit
            that weakness.
          </li>
        )}
        {unattrPct >= 10 && (
          <li>
            <strong>{unattrPct}% of spend is not attributable to a mission</strong> (
            {usd(report.unattributed.costUsd)} across {report.unattributed.branches.length} branches).
            Reported, never dropped — but per-mission rows understate true cost by this much.
          </li>
        )}
        {report.unpricedModels.length > 0 && (
          <li>
            <strong>Unpriced models:</strong> {report.unpricedModels.join(", ")} — their cost reads
            as zero. Refresh the price table.
          </li>
        )}
        {noEstimate.length === 0 && unattrPct < 10 && report.unpricedModels.length === 0 && (
          <li>No gaps detected.</li>
        )}
      </ul>
    </div>
  );
}
