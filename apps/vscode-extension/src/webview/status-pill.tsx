export type MissionStatus = "draft" | "executing" | "awaitingApproval" | "done" | "failed" | "cancelled";
/** Campaign/task rollup statuses (from rollupMissionCounts) reuse the same pill. */
export type RollupStatus = "empty" | "draft" | "active" | "completed" | "failed" | "cancelled";

const LABEL: Record<string, string> = {
  draft: "draft",
  executing: "executing",
  awaitingApproval: "awaiting approval",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  // campaign/task rollup vocabulary
  empty: "empty",
  active: "active",
  completed: "completed",
};

const COLOR_CLASS: Record<string, string> = {
  draft: "bg-mission-draft text-fg-button",
  executing: "bg-mission-executing text-fg-button",
  awaitingApproval: "bg-mission-awaiting text-fg-button",
  done: "bg-mission-done text-fg-button",
  failed: "bg-mission-failed text-fg-button",
  cancelled: "bg-mission-cancelled text-fg-button",
  // rollup: an open campaign is "active" (work in flight); reuse the executing green + pulse.
  empty: "bg-mission-draft text-fg-button",
  active: "bg-mission-executing text-fg-button",
  completed: "bg-mission-done text-fg-button",
};

/** Statuses that read as "in progress" and therefore pulse. */
const PULSING = new Set(["executing", "active"]);

export interface StatusPillProps {
  status: MissionStatus | RollupStatus | string;
  className?: string;
}

export function StatusPill({ status, className = "" }: StatusPillProps): JSX.Element {
  // Coerce anything outside the known vocabulary to a neutral pill rather than breaking styling.
  const s = status in LABEL ? status : "draft";
  // "In progress" pulses so it reads as live at a glance (vs. the solid "done"/"completed" pill).
  const pulse = PULSING.has(s) ? " animate-pulse" : "";
  return (
    <span
      data-status={s}
      className={`inline-flex items-center h-[1.125rem] px-1.5 rounded text-xs font-medium ${COLOR_CLASS[s]}${pulse} ${className}`.trim()}
    >
      {LABEL[s]}
    </span>
  );
}
