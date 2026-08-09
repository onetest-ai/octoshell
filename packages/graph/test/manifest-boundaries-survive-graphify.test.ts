import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { analyze } from "../src/analyze.js";
import { DEFAULTS } from "../src/config.js";

const NOW = Date.UTC(2026, 0, 30);

/**
 * The regression this file guards: `declaredSpine` picks its module BOUNDARY
 * and its EDGE source independently (see spine.ts). Coupling them — letting a
 * present `graphify-out/graph.json` also downgrade boundaries to the crude
 * two-segment directory heuristic — would make the highest-fidelity edge
 * source produce the WORST module names in any repo whose real packages sit
 * three (or more) path segments deep, e.g. `services/team-a/api-gateway`. The
 * two-segment fallback collapses that down to `services/team-a`, merging two
 * distinct packages into one module.
 *
 * `spine.test.ts` exercises `declaredSpine` directly with only two-segment
 * packages, where the fallback happens to agree with the manifest boundary
 * and so cannot catch this inversion. This test drives the full pipeline
 * (`analyze`, a real git repo, a real `pnpm-workspace.yaml` glob one level
 * deeper) against a three-segment layout, with a real Graphify graph.json
 * present — the exact combination the bug needs to surface.
 */
function threeSegmentRepo(): string {
  const commits: CommitSpec[] = [];
  // Each package's two files co-change with each other, never across
  // packages, so the module split is unambiguous.
  for (let i = 0; i < 6; i++) {
    commits.push({
      files: ["services/team-a/api-gateway/src/x.ts", "services/team-a/api-gateway/src/y.ts"],
    });
  }
  for (let i = 0; i < 6; i++) {
    commits.push({ files: ["services/team-a/worker/src/z.ts", "services/team-a/worker/src/w.ts"] });
  }

  const root = buildRepo(commits);

  // A workspace glob that expands one directory level below `services/team-a`
  // — the real package roots sit THREE segments deep, not two.
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'services/team-a/*'\n");
  writeFileSync(
    join(root, "services/team-a/api-gateway/package.json"),
    '{"name":"api-gateway"}\n',
  );
  writeFileSync(join(root, "services/team-a/worker/package.json"), '{"name":"worker"}\n');

  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(
    join(root, "graphify-out/graph.json"),
    JSON.stringify({
      nodes: [
        { id: "1", file: "services/team-a/api-gateway/src/x.ts" },
        { id: "2", file: "services/team-a/worker/src/z.ts" },
      ],
      edges: [{ source: "1", target: "2", type: "imports" }],
    }),
  );

  return root;
}

describe("end-to-end: manifest boundaries survive Graphify's edge-only contribution", () => {
  it("keeps the three-segment package boundary instead of collapsing to the two-segment fallback", () => {
    const root = threeSegmentRepo();
    const { analysis, spine } = analyze(root, DEFAULTS, { now: NOW });

    // Best available edge source really is Graphify.
    expect(spine.source).toBe("graphify");

    // The boundary the spine itself reports is the manifest one, not the
    // two-segment fallback that would read both files as "services/team-a".
    expect(spine.moduleOf("services/team-a/api-gateway/src/x.ts")).toBe(
      "services/team-a/api-gateway",
    );
    expect(spine.moduleOf("services/team-a/worker/src/z.ts")).toBe("services/team-a/worker");

    // And the boundary survives into the committed artifact: two distinct
    // module headings, not one merged "services/team-a".
    const names = analysis.modules.map((m) => m.name);
    expect(names).toContain("services/team-a/api-gateway");
    expect(names).toContain("services/team-a/worker");
    expect(names).not.toContain("services/team-a");

    // The module-level dependency edge Graphify declared keeps the same
    // three-segment names — it is not re-derived through the fallback either.
    expect(analysis.moduleEdges).toEqual([
      { from: "services/team-a/api-gateway", to: "services/team-a/worker", weight: 1 },
    ]);
  });
});
