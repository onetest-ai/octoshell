// Test-case summaries for the sidebar's Tests node and the campaign panel (M6 T6.3). Pure: BoardHost feeds it
// what BoardModel already knows and the tree formats what comes back, so neither re-derives a count.

import type { MissionCoverage, TestCase, TestCaseStatus } from "@octoshell/board";
import type { MissionTestSummary, TestStatusCounts, TestSummary } from "../protocol/index.js";

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

const folderKey = (folder: string): [number, string] => {
  const m = /^m(\d+)(.*)$/.exec(folder);
  return [Number(m?.[1] ?? 0), m?.[2] ?? ""];
};

/**
 * The campaign's test summary.
 *
 * Uncovered ACs: a cancelled mission is excluded entirely (it contributes no uncovered AC), and a live
 * mission with no `tests/m<n>/` folder counts all its ACs as uncovered, since that is the gap the board should
 * show. A tests folder no mission names is totalled and listed but can have no uncovered AC.
 * Totals by status cover every TC on disk, a cancelled mission's included.
 */
export function summarizeTests(opts: {
  campaignId: string;
  cases: readonly TestCase[];
  missions: ReadonlyArray<{ id: string; title: string; status: string; coverage: MissionCoverage }>;
}): TestSummary {
  const { campaignId, cases, missions } = opts;
  const byFolder = new Map<string, TestCase[]>();
  for (const tc of cases) {
    const folder = tc.mission.toLowerCase();
    const list = byFolder.get(folder);
    if (list) list.push(tc);
    else byFolder.set(folder, [tc]);
  }
  const rows = new Map<string, MissionTestSummary>();
  for (const m of missions) {
    const token = m.coverage.mission;
    if (!token) continue; // a mission name without an `M<n>` token has no AC ids and no folder
    const folder = token.toLowerCase();
    if (rows.has(folder)) continue; // two missions claiming one token: the first keeps the row
    const own = byFolder.get(folder) ?? [];
    rows.set(folder, {
      missionId: m.id,
      mission: token,
      folder,
      title: m.title,
      missionStatus: m.status,
      total: own.length,
      counts: countByStatus(own),
      uncovered: m.status === "cancelled" ? [] : m.coverage.uncovered,
    });
  }
  for (const [folder, own] of byFolder) {
    if (rows.has(folder)) continue;
    rows.set(folder, {
      missionId: null,
      mission: `M${folder.slice(1)}`,
      folder,
      title: null,
      missionStatus: null,
      total: own.length,
      counts: countByStatus(own),
      uncovered: [],
    });
  }
  const sorted = [...rows.values()].sort((a, b) => {
    const [na, sa] = folderKey(a.folder);
    const [nb, sb] = folderKey(b.folder);
    return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
  });
  return {
    campaignId,
    total: cases.length,
    counts: countByStatus(cases),
    uncovered: sorted.reduce((n, r) => n + r.uncovered.length, 0),
    missions: sorted,
  };
}
