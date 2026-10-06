// Shared bits of the Tests views (M6 T6.4): one status vocabulary, order and look for the mission panel and the
// campaign panel, the same one the sidebar uses (host/test-summary.ts owns the order).
import type { TestCaseStatus } from "@octoshell/board";
import { TEST_STATUS_ORDER } from "../host/test-summary.js";

export { TEST_STATUS_ORDER };

/** Icon and theme-token colour per status. Colour is never the only signal: the status word always renders too. */
const LOOK: Record<TestCaseStatus, { icon: string; tone: string }> = {
  pass: { icon: "codicon-pass", tone: "text-status-success" },
  fail: { icon: "codicon-error", tone: "text-status-error" },
  blocked: { icon: "codicon-circle-slash", tone: "text-status-warning" },
  ready: { icon: "codicon-circle-large-outline", tone: "text-status-info" },
  draft: { icon: "codicon-edit", tone: "text-fg-muted" },
  unknown: { icon: "codicon-question", tone: "text-fg-muted" }, // legacy TC: neutral, never a warning (decision 12)
};

export function TestStatusBadge({ status }: { status: TestCaseStatus }): JSX.Element {
  const look = LOOK[status];
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${look.tone}`}>
      <span className={`codicon ${look.icon}`} aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

/** The warning treatment for an uncovered acceptance criterion: text and icon, from the warning token, never error. */
export function UncoveredMark({ label = "uncovered" }: { label?: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-status-warning">
      <span className="codicon codicon-warning" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
