import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { analyze } from "../src/analyze.js";
import { renderMap } from "../src/render.js";
import { DEFAULTS } from "../src/config.js";
import type { ModuleSummary } from "../src/analyze.js";

const NOW = Date.UTC(2026, 0, 30);

function moduleNamed(modules: ModuleSummary[], name: string): ModuleSummary {
  const m = modules.find((mod) => mod.name === name);
  if (m === undefined) throw new Error(`expected a module named ${name}, got none`);
  return m;
}

/**
 * Four declared modules, each backed by its own tight internal co-change
 * pair so Louvain resolves them into four distinct communities with no
 * cross-module edges to blur the boundary.
 */
function fourModuleCommits(): CommitSpec[] {
  const commits: CommitSpec[] = [];
  for (let i = 0; i < 6; i++) commits.push({ files: ["svc/a/a1.ts", "svc/a/a2.ts"] });
  for (let i = 0; i < 6; i++) commits.push({ files: ["svc/b/b1.ts", "svc/b/b2.ts"] });
  for (let i = 0; i < 6; i++) commits.push({ files: ["svc/c/c1.ts", "svc/c/c2.ts"] });
  for (let i = 0; i < 6; i++) commits.push({ files: ["svc/d/d1.ts", "svc/d/d2.ts"] });
  return commits;
}

function writeManifest(root: string): void {
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'svc/*'\n");
  for (const pkg of ["a", "b", "c", "d"]) {
    writeFileSync(join(root, `svc/${pkg}/package.json`), `{"name":"${pkg}"}\n`);
  }
}

/** a -> b, b <-> c (cycle), c -> d, at the MODULE level via Graphify. */
function writeCyclicGraphify(root: string): void {
  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(
    join(root, "graphify-out/graph.json"),
    JSON.stringify({
      nodes: [
        { id: "a1", file: "svc/a/a1.ts" },
        { id: "b1", file: "svc/b/b1.ts" },
        { id: "c1", file: "svc/c/c1.ts" },
        { id: "d1", file: "svc/d/d1.ts" },
      ],
      edges: [
        { source: "a1", target: "b1", type: "imports" },
        { source: "b1", target: "c1", type: "imports" },
        { source: "c1", target: "b1", type: "imports" },
        { source: "c1", target: "d1", type: "imports" },
      ],
    }),
  );
}

describe("end-to-end: a module downstream of a dependency cycle ranks strictly deeper than the cycle", () => {
  it("contracts b<->c to one rank and ranks d strictly below it, through the full pipeline", () => {
    const root = buildRepo(fourModuleCommits());
    writeManifest(root);
    writeCyclicGraphify(root);

    const { analysis, spine } = analyze(root, DEFAULTS, { now: NOW });
    expect(spine.source).toBe("graphify");

    const a = moduleNamed(analysis.modules, "svc/a");
    const b = moduleNamed(analysis.modules, "svc/b");
    const c = moduleNamed(analysis.modules, "svc/c");
    const d = moduleNamed(analysis.modules, "svc/d");

    expect(a.layer).toBe(0);
    expect(b.layer).not.toBeNull();
    expect(c.layer).not.toBeNull();
    // The cycle members contract to one rank...
    expect(b.layer).toBe(c.layer);
    // ...and a module downstream of the cycle ranks strictly deeper, not
    // flattened into the same rank as the cycle by a naive Kahn sweep.
    expect(d.layer).toBeGreaterThan(c.layer ?? -1);

    // The rendered map carries the same layer numbers a reader would check
    // against, not just the in-memory Analysis.
    const md = renderMap(analysis, DEFAULTS.budgetTokens);
    expect(md).toContain(`**svc/a** [layer ${String(a.layer)}]`);
    expect(md).toContain(`**svc/d** [layer ${String(d.layer)}]`);
  });
});

describe("end-to-end: ranks vanish entirely with no import edges", () => {
  it("omits every layer, and map.md carries no layer annotation, when the spine has no directed edges", () => {
    // Same module shape, same co-change signal — but no graphify-out and no
    // workspace manifest, so `spine.imports` is empty and moduleEdges falls
    // back to the undirected co-change rollup, which layerRanks refuses to
    // guess a direction from.
    const root = buildRepo(fourModuleCommits());

    const { analysis, spine } = analyze(root, DEFAULTS, { now: NOW });
    expect(spine.imports).toEqual([]);
    expect(analysis.modules.length).toBeGreaterThan(0);
    for (const m of analysis.modules) expect(m.layer).toBeNull();

    const md = renderMap(analysis, DEFAULTS.budgetTokens);
    expect(md).not.toContain("[layer");
  });
});
