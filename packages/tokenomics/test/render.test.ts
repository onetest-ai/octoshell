import { describe, it, expect } from "vitest";
import { renderReportHtml } from "../src/render.js";
import { emptyEstimate, emptyTotals, type Report } from "../src/types.js";

const report = (over: Partial<Report> = {}): Report => ({
  generatedAt: "2026-07-22T00:00:00.000Z",
  agentTool: "claude-code",
  pricesFetchedAt: "2026-07-22",
  runs: [
    {
      missionId: "folder:campaigns/demo/missions/m1",
      missionTitle: "M1 - Demo mission",
      campaignId: "folder:campaigns/demo",
      estimate: { ...emptyEstimate(), effortDays: 4, sizeTshirt: "L" },
      branches: ["feat/demo-m1"],
      sessions: 1,
      turns: 100,
      subagentDispatches: 3,
      orchestratorCostPct: 60,
      cacheReadSharePct: 80,
      tokens: { ...emptyTotals(), output: 1_000_000, cacheRead: 9_000_000 },
      costByModel: { "claude-opus-4-8": 30, "claude-sonnet-5": 10 },
      costUsd: 40,
      tasks: [
        {
          taskId: "T1.1", name: "First", status: "done",
          estimate: { ...emptyEstimate(), effortDays: 2, sizeTshirt: "M" },
          branches: ["feat/demo-m1-t1"], turns: 60, subagentDispatches: 2,
          orchestratorCostPct: 50, attribution: "worklog",
          tokens: { ...emptyTotals(), output: 500_000 },
          costUsd: 30, costSharePct: 75, unmeasured: false,
        },
        {
          taskId: "T1.2", name: "Never ran", status: "draft",
          estimate: emptyEstimate(), branches: [], turns: 0, subagentDispatches: 0,
          orchestratorCostPct: 100, attribution: null, tokens: emptyTotals(),
          costUsd: 0, costSharePct: 0, unmeasured: true,
        },
      ],
    },
  ],
  unattributed: { segments: 1, turns: 5, branches: ["main"], tokens: emptyTotals(), costUsd: 2 },
  unpricedModels: [],
  ...over,
});

describe("renderReportHtml", () => {
  it("is self-contained — no CDN, font, script or fetch reference", () => {
    const html = renderReportHtml(report());
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css|woff2?)/i);
    expect(html).not.toMatch(/\bfetch\(/);
  });

  it("renders the mission, its tasks, and the totals", () => {
    const html = renderReportHtml(report());
    expect(html).toContain("M1 - Demo mission");
    expect(html).toContain("T1.1");
    expect(html).toContain("$42.00"); // attributed 40 + unattributed 2
    expect(html).toContain("demo"); // campaign, stripped of the folder: prefix
  });

  it("keeps a declared-but-unmeasured task visible rather than dropping it", () => {
    const html = renderReportHtml(report());
    expect(html).toContain("Never ran");
    expect(html).toContain("not measured");
  });

  it("shows the per-model split from priced costs, not token share", () => {
    const html = renderReportHtml(report());
    expect(html).toMatch(/claude-opus-4-8 — <strong>\$30\.00<\/strong> \(75%\)/);
  });

  it("raises unattributed spend above 10% as a finding", () => {
    // 10 of 50 total = 20%, past the threshold.
    const html = renderReportHtml(
      report({ unattributed: { segments: 1, turns: 5, branches: ["main"], tokens: emptyTotals(), costUsd: 10 } }),
    );
    expect(html).toMatch(/20% of spend is not attributable to a mission/);
  });

  it("stays quiet about unattributed spend below the threshold", () => {
    // 2 of 42 = under 5% — noise, not a finding.
    expect(renderReportHtml(report())).not.toMatch(/not attributable to a mission/);
  });

  it("flags unpriced models, whose cost silently reads as zero", () => {
    const html = renderReportHtml(report({ unpricedModels: ["mystery"] }));
    expect(html).toContain("mystery");
    expect(html).toMatch(/no price entry/);
  });

  it("escapes board text rather than injecting it as markup", () => {
    const r = report();
    r.runs[0]!.missionTitle = '<img src=x onerror="alert(1)">';
    const html = renderReportHtml(r);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("renders an empty report without throwing", () => {
    const html = renderReportHtml(
      report({
        runs: [],
        unattributed: { segments: 0, turns: 0, branches: [], tokens: emptyTotals(), costUsd: 0 },
      }),
    );
    expect(html).toContain("No gaps detected");
    expect(html).toContain("$0.00");
  });
});
