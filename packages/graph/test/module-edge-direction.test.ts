import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { analyze } from "../src/analyze.js";
import { renderMap } from "../src/render.js";
import { DEFAULTS } from "../src/config.js";
import type { Analysis } from "../src/analyze.js";

const NOW = Date.UTC(2026, 0, 30);

/**
 * `Analysis.moduleEdges` has two producers that do not mean the same thing, and
 * only one of them can back an arrow.
 *
 *  - `readGraphify` emits a declared import edge. `from` really does depend on
 *    `to`.
 *  - `rollUp` projects co-change, which has no direction whatsoever. It orders
 *    the two endpoints lexicographically — purely to key its accumulator — and
 *    the renderer used to print that as `from → to` regardless of which
 *    producer supplied it.
 *
 * That is not a cosmetic overstatement. Lexicographic order agrees with the
 * real dependency direction about half the time, so map.md — which is loaded
 * into a coding agent's context as architecture truth — asserted the exact
 * reverse of the truth for every pair whose dependency runs against the
 * alphabet: `web` importing `api` rolls up to `api → web`, i.e. "api depends
 * on web".
 */
const base: Omit<Analysis, "moduleEdges" | "moduleEdgesDirected" | "spineSource"> = {
  commitCount: 40,
  fileCount: 12,
  modules: [
    { id: 0, name: "api", members: ["api/a.ts"], layer: null },
    { id: 1, name: "web", members: ["web/b.ts"], layer: null },
  ],
  hubs: [],
  bridged: 0,
  clusterIds: { kept: 0, fresh: 2 },
};

describe("renderMap: an arrow is a claim only a declared spine can back", () => {
  it("renders a co-change rollup as a symmetric coupling, never as a direction", () => {
    const md = renderMap(
      {
        ...base,
        spineSource: "manifests",
        moduleEdgesDirected: false,
        moduleEdges: [{ from: "api", to: "web", weight: 3.2 }],
      },
      2000,
    );
    expect(md).toContain("- api ↔ web (3.20)");
    // The load-bearing half: no arrow anywhere in the document, and the
    // section is not titled as though these were declared dependencies.
    expect(md).not.toContain("→");
    expect(md).not.toContain("## Dependencies");
    expect(md).toContain("## Coupling (undirected co-change)");
  });

  it("keeps the direction a Graphify spine actually declared", () => {
    const md = renderMap(
      {
        ...base,
        spineSource: "graphify",
        moduleEdgesDirected: true,
        moduleEdges: [{ from: "web", to: "api", weight: 1 }],
      },
      2000,
    );
    expect(md).toContain("## Dependencies");
    expect(md).toContain("- web → api (1.00)");
    expect(md).not.toContain("↔");
  });
});

describe("end-to-end: the rendered relation matches the tier that produced it", () => {
  /**
   * `web` imports `api`, and the co-change rollup can only ever key that pair
   * as ("api", "web"). Driving it through the full pipeline is what proves the
   * renderer is reading the producer and not a hand-set flag — and the same
   * repo analysed with and without `graphify-out/` isolates the tier as the
   * only variable.
   */
  function repoWhereDependencyRunsBackwardsOfTheAlphabet(withGraphify: boolean): string {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/api/a2.ts", "pkg/api/a3.ts"] });
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/web/w2.ts", "pkg/web/w3.ts"] });
    // Cross-package churn, so the rollup has an inter-module edge to report.
    // These two files move ONLY with each other, so the pair scores above
    // chance — a file that also carries its package's own churn dilutes its
    // marginal until nPMI goes negative and `edgeWeight` floors the edge away.
    for (let i = 0; i < 4; i++) commits.push({ files: ["pkg/api/a1.ts", "pkg/web/w1.ts"] });

    const root = buildRepo(commits);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'pkg/*'\n");
    for (const p of ["api", "web"]) {
      writeFileSync(join(root, `pkg/${p}/package.json`), `{"name":"${p}"}\n`);
    }
    if (withGraphify) {
      mkdirSync(join(root, "graphify-out"), { recursive: true });
      writeFileSync(
        join(root, "graphify-out/graph.json"),
        JSON.stringify({
          nodes: [
            { id: "w", file: "pkg/web/w1.ts" },
            { id: "a", file: "pkg/api/a1.ts" },
          ],
          // The truth: web depends on api. Lexicographic order says otherwise.
          edges: [{ source: "w", target: "a", type: "imports" }],
        }),
      );
    }
    return root;
  }

  it("states only coupling when the spine is manifests, and never inverts the dependency", () => {
    const { analysis } = analyze(
      repoWhereDependencyRunsBackwardsOfTheAlphabet(false),
      DEFAULTS,
      { now: NOW },
    );
    expect(analysis.spineSource).toBe("manifests");
    expect(analysis.moduleEdgesDirected).toBe(false);
    // Precondition: the rollup really does key this pair alphabetically, which
    // is the reverse of the real import direction.
    expect(analysis.moduleEdges[0]?.from).toBe("pkg/api");
    expect(analysis.moduleEdges[0]?.to).toBe("pkg/web");

    const md = renderMap(analysis, DEFAULTS.budgetTokens);
    expect(md).toContain("pkg/api ↔ pkg/web");
    expect(md).not.toContain("pkg/api → pkg/web");
  });

  it("states the declared direction when Graphify supplies one", () => {
    const { analysis } = analyze(
      repoWhereDependencyRunsBackwardsOfTheAlphabet(true),
      DEFAULTS,
      { now: NOW },
    );
    expect(analysis.spineSource).toBe("graphify");
    expect(analysis.moduleEdgesDirected).toBe(true);
    const md = renderMap(analysis, DEFAULTS.budgetTokens);
    expect(md).toContain("pkg/web → pkg/api");
  });
});
