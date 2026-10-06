// The mission panel's Tests section and AC coverage view (M6 T6.4).
import type { MissionCoverage, TestCase } from "@octoshell/board";
import { TEST_STATUS_ORDER, TestStatusBadge, UncoveredMark } from "./tests-ui.js";

const rank = (tc: TestCase): number => TEST_STATUS_ORDER.indexOf(tc.status);

export function MissionTests(
  { cases, coverage, onOpenTestCase }: { cases: TestCase[]; coverage: MissionCoverage | null; onOpenTestCase?: (path: string) => void },
): JSX.Element {
  const ordered = [...cases].sort((a, b) => rank(a) - rank(b)); // stable: ids keep their order within a status
  return (
    <section aria-labelledby="mission-tests-h">
      <h2 id="mission-tests-h" className="text-sm uppercase text-fg-muted mb-2">Tests</h2>
      {ordered.length === 0 ? (
        <div className="text-sm text-fg-muted">
          No tests yet. To create the tests folder: <code className="font-mono">run add-tests.js &lt;mission-dir&gt;</code>
        </div>
      ) : (
        <ul className="border border-border rounded overflow-hidden">
          {ordered.map((tc) => (
            <li
              key={tc.path}
              data-testid="tc-row"
              data-status={tc.status}
              className="flex items-center gap-3 px-2 py-1.5 border-t border-border first:border-t-0 hover:bg-list-hover"
            >
              <button
                onClick={() => onOpenTestCase?.(tc.path)}
                aria-label={`Open ${tc.id} ${tc.title}`}
                className="flex-1 min-w-0 text-left truncate"
              >
                <span className="font-mono text-fg-muted mr-2">{tc.id}</span>{tc.title}
              </button>
              {tc.lastRun ? <span className="shrink-0 text-xs text-fg-muted">{tc.lastRun.date}</span> : null}
              <TestStatusBadge status={tc.status} />
            </li>
          ))}
        </ul>
      )}

      {coverage && coverage.acs.length > 0 ? (
        <div className="mt-3">
          <table aria-label="Acceptance criteria coverage" className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs uppercase text-fg-muted">
                <th scope="col" className="py-1 pr-2 font-normal">AC</th>
                <th scope="col" className="py-1 pr-2 font-normal">Criterion</th>
                <th scope="col" className="py-1 font-normal">Covered by</th>
              </tr>
            </thead>
            <tbody>
              {coverage.acs.map((a) => (
                <tr key={a.ac} data-testid="ac-row" data-covered={String(a.covered)} className="border-t border-border align-top">
                  <th scope="row" className="py-1 pr-2 text-left font-mono font-normal whitespace-nowrap">{a.ac}</th>
                  <td className="py-1 pr-2">{a.text}</td>
                  <td className="py-1">
                    {a.covered ? <span className="font-mono">{a.tcs.map((id) => <span key={id} className="mr-2">{id}</span>)}</span> : <UncoveredMark />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
