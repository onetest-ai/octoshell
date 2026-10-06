// The test-case status vocabulary shared by the host (sidebar tree, BoardHost summary) and the webview (mission
// and campaign panels): one order and one count format everywhere. Lives in protocol/ because both sides import
// it; it must stay pure (type-only imports, no Node APIs), since the webview bundle includes it.

import type { TestCase, TestCaseStatus } from "@octoshell/board";
import type { TestStatusCounts } from "./rpc-contract.js";

/** The order a status appears in, anywhere it is listed: what passed first, what is not yet known last. */
export const TEST_STATUS_ORDER = ["pass", "fail", "blocked", "ready", "draft", "unknown"] as const satisfies readonly TestCaseStatus[];

export const emptyCounts = (): TestStatusCounts => ({ pass: 0, fail: 0, blocked: 0, ready: 0, draft: 0, unknown: 0 });

export function countByStatus(cases: readonly TestCase[]): TestStatusCounts {
  const counts = emptyCounts();
  for (const tc of cases) counts[tc.status]++;
  return counts;
}

/** How one status reads in a label: `30✓`, `1✗`, `1 blocked`, `3 ready`, `2 draft`, `1 unknown`. */
const countText = (status: TestCaseStatus, n: number): string =>
  status === "pass" ? `${n}✓` : status === "fail" ? `${n}✗` : `${n} ${status}`;

/** `30✓ 1✗ 1 blocked`: in {@link TEST_STATUS_ORDER}, zero counts omitted. Empty for no cases. */
export function formatCounts(counts: TestStatusCounts): string {
  return TEST_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => countText(s, counts[s])).join(" ");
}

/** A mission group's label: `m2 · 32 · 30✓ 1✗ 1 blocked`. */
export function groupLabel(folder: string, total: number, counts: TestStatusCounts): string {
  return `${folder} · ${total} · ${formatCounts(counts)}`;
}
