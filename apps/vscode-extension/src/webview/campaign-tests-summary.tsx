// The campaign panel's test summary (M6 T6.4): totals by status, uncovered ACs, one row per mission.
import { formatCounts, type TestSummary } from "../protocol/index.js";
import { TEST_STATUS_ORDER, TestStatusBadge, UncoveredMark } from "./tests-ui.js";

export function CampaignTestsSummary(
  { summary, onOpenMission }: { summary: TestSummary | null; onOpenMission: (missionId: string) => void },
): JSX.Element | null {
  if (!summary || (summary.total === 0 && summary.uncovered === 0 && summary.missions.length === 0)) return null;
  return (
    <section aria-labelledby="campaign-tests-h">
      <h2 id="campaign-tests-h" className="text-sm uppercase text-fg-muted mb-2">Tests</h2>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2" aria-label="Test totals by status">
        {TEST_STATUS_ORDER.map((s) => (
          <li key={s} data-testid={`total-${s}`} className="inline-flex items-center gap-1">
            <TestStatusBadge status={s} />
            <span className="font-mono">{summary.counts[s]}</span>
          </li>
        ))}
        <li data-testid="uncovered-total" className={summary.uncovered > 0 ? "text-status-warning" : "text-fg-muted"}>
          {summary.uncovered > 0 ? <span className="codicon codicon-warning mr-1" aria-hidden="true" /> : null}
          <span className="font-mono">{summary.uncovered}</span> uncovered {summary.uncovered === 1 ? "AC" : "ACs"}
        </li>
      </ul>
      <ul className="border border-border rounded overflow-hidden">
        {summary.missions.map((m) => (
          <li
            key={m.folder}
            data-testid="summary-row"
            data-folder={m.folder}
            data-mission-id={m.missionId ?? ""}
            className="flex flex-wrap items-center gap-x-3 px-2 py-1.5 border-t border-border first:border-t-0"
          >
            {m.missionId ? (
              <button
                onClick={() => onOpenMission(m.missionId!)}
                aria-label={`Open ${m.mission}${m.title ? ` ${m.title}` : ""}`}
                className="flex-1 min-w-0 text-left truncate hover:bg-list-hover"
              >
                {m.title ?? m.mission}
              </button>
            ) : (
              <span className="flex-1 min-w-0 truncate text-fg-muted">tests/{m.folder}, no matching mission</span>
            )}
            {m.missionStatus === "cancelled" ? <span className="text-xs text-fg-muted">cancelled</span> : null}
            <span className="shrink-0 text-xs text-fg-muted">
              {m.total === 0 ? "no tests" : `${m.total} · ${formatCounts(m.counts)}`}
            </span>
            {m.uncovered.length > 0 ? (
              <span data-testid="uncovered-acs" className="shrink-0 text-xs">
                <UncoveredMark label={`uncovered: ${m.uncovered.join(", ")}`} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
