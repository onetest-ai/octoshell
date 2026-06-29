export interface Rollup {
  total: number; active: number; completed: number; failed: number; cancelled: number; draft: number;
  rollupStatus: "draft" | "active" | "completed" | "failed" | "cancelled";
}

/** Bucket entity statuses into a campaign rollup. */
export function rollupCampaign(statuses: string[]): Rollup {
  let active = 0, completed = 0, failed = 0, cancelled = 0, draft = 0;
  for (const s of statuses) {
    if (s === "active" || s === "executing" || s === "awaitingApproval") active++;
    else if (s === "done" || s === "completed") completed++;
    else if (s === "failed") failed++;
    else if (s === "cancelled") cancelled++;
    else draft++;
  }
  const total = statuses.length;
  const rollupStatus: Rollup["rollupStatus"] =
    total === 0 ? "draft"
    : active > 0 ? "active"
    : failed > 0 ? "failed"
    : completed === total ? "completed"
    : completed > 0 ? "active"
    : cancelled === total ? "cancelled"
    : "draft";
  return { total, active, completed, failed, cancelled, draft, rollupStatus };
}
