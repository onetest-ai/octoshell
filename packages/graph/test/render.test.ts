import { describe, expect, it } from "vitest";
import { estimateTokens, renderMap } from "../src/render.js";
import type { Analysis } from "../src/analyze.js";

const analysis: Analysis = {
  commitCount: 400,
  fileCount: 120,
  spineSource: "manifests",
  modules: [
    { id: 0, name: "packages/board", members: ["packages/board/src/a.ts"], layer: 1 },
    { id: 1, name: "apps/ext", members: ["apps/ext/src/b.ts"], layer: 0 },
  ],
  moduleEdges: [{ from: "apps/ext", to: "packages/board", weight: 3.2 }],
  hubs: ["package.json"],
  bridged: 0,
  clusterIds: { kept: 2, fresh: 0 },
};

describe("renderMap", () => {
  it("lists every module and its layer", () => {
    const md = renderMap(analysis, 2000);
    expect(md).toContain("packages/board");
    expect(md).toContain("apps/ext");
  });

  it("stays within the token budget by dropping least-central modules", () => {
    const big: Analysis = {
      ...analysis,
      modules: Array.from({ length: 500 }, (_, i) => ({
        id: i,
        name: `module/number-${i}`,
        members: [`module/number-${i}/file.ts`],
        layer: 0,
      })),
    };
    expect(estimateTokens(renderMap(big, 500))).toBeLessThanOrEqual(500);
  });

  it("is byte-identical across runs for the same input", () => {
    expect(renderMap(analysis, 2000)).toBe(renderMap(analysis, 2000));
  });

  it("notes when the map was truncated", () => {
    const big: Analysis = {
      ...analysis,
      modules: Array.from({ length: 500 }, (_, i) => ({
        id: i, name: `m/${i}`, members: [`m/${i}/f.ts`], layer: 0,
      })),
    };
    expect(renderMap(big, 300)).toContain("truncated");
  });

  /**
   * The dependency list is quadratic in the module count, so it — not the
   * module list — is the section that overruns a real repo's budget. Trimming
   * only modules left it whole: with 400 edges the map came out at ~3500 tokens
   * against a 500-token budget however far the module list was cut back, which
   * defeats the one thing the budget is for (keeping map.md loadable as agent
   * context).
   */
  it("stays within the budget when the dependency section is the large one", () => {
    const edgeHeavy: Analysis = {
      ...analysis,
      modules: [{ id: 0, name: "pkg/only", members: ["pkg/only/x.ts"], layer: null }],
      moduleEdges: Array.from({ length: 400 }, (_, i) => ({
        from: `pkg/from-${i}`,
        to: `pkg/to-${i}`,
        weight: 1.5,
      })),
    };
    const md = renderMap(edgeHeavy, 500);
    expect(estimateTokens(md)).toBeLessThanOrEqual(500);
    expect(md).toContain("dependency edge(s) truncated");
    // Trimming must not starve one section to pay for the other: the single
    // module survives a cut that drops hundreds of edges.
    expect(md).toContain("pkg/only");
  });

  it("degrades to the header rather than looping when the budget is unreachably small", () => {
    const md = renderMap(analysis, 1);
    expect(md).toContain("# Module map");
    expect(md).not.toContain("packages/board");
  });
});
