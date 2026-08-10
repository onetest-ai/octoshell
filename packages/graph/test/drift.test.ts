import { describe, expect, it } from "vitest";
import { drift } from "../src/drift.js";
import type { Edge } from "../src/weights.js";
import type { Spine } from "../src/spine.js";

const files = [
  "package.json",
  "pnpm-lock.yaml",
  "svc/a/client.ts",
  "svc/a/client.test.ts",
  "svc/b/api.ts",
];

const spine: Spine = {
  source: "manifests",
  modules: ["svc/a", "svc/b", "."],
  moduleOf: (p) => (p.includes("/") ? p.split("/").slice(0, 2).join("/") : "."),
  imports: [],
};

const edge = (a: number, b: number, npmi: number): Edge => ({
  a,
  b,
  support: 8,
  npmi,
  confidence: 0.7,
});

describe("drift", () => {
  const edges = [
    edge(0, 1, 1.0), // manifest <-> lockfile — mechanical, must not surface
    edge(2, 3, 0.95), // client <-> its test  — test-subject, must not surface
    edge(2, 4, 0.85), // client <-> other service's api — THE finding
  ];

  it("surfaces the cross-boundary pair", () => {
    expect(drift(edges, files, spine)[0]?.a).toBe("svc/a/client.ts");
    expect(drift(edges, files, spine)[0]?.b).toBe("svc/b/api.ts");
  });

  it("excludes mechanical and test pairs even at higher nPMI", () => {
    const paths = drift(edges, files, spine).flatMap((r) => [r.a, r.b]);
    expect(paths).not.toContain("pnpm-lock.yaml");
    expect(paths).not.toContain("svc/a/client.test.ts");
  });

  it("excludes pairs the declared spine already relates", () => {
    const withImport: Spine = {
      ...spine,
      imports: [{ from: "svc/a", to: "svc/b", weight: 1 }],
    };
    expect(drift(edges, files, withImport)).toHaveLength(0);
  });

  it("excludes intra-module pairs", () => {
    const intraFiles = ["svc/a/client.ts", "svc/a/other.ts"];
    const intraEdges = [edge(0, 1, 0.9)];
    expect(drift(intraEdges, intraFiles, spine)).toHaveLength(0);
  });

  it("honours the limit", () => {
    expect(drift(edges, files, spine, 0)).toHaveLength(0);
  });

  it("ignores a synthetic bridge edge (support 0), which carries no evidence", () => {
    const bridge: Edge = { ...edge(2, 4, 0.99), support: 0 };
    // The bridge duplicates the real finding's endpoints but carries no support,
    // so it must not produce a second row or otherwise perturb the result.
    expect(drift([...edges, bridge], files, spine)).toHaveLength(1);
  });
});
