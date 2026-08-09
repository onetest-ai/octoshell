import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGraphify } from "../src/graphify.js";

const moduleOf = (p: string) => p.split("/").slice(0, 2).join("/");

function repoWithGraph(graph: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "gfy-"));
  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(join(root, "graphify-out", "graph.json"), JSON.stringify(graph));
  return root;
}

describe("readGraphify", () => {
  it("returns null when graphify has not run", () => {
    expect(readGraphify(mkdtempSync(join(tmpdir(), "none-")), moduleOf)).toBeNull();
  });

  it("extracts module-level import edges and drops self-loops", () => {
    const root = repoWithGraph({
      nodes: [
        { id: "1", file: "pkg/a/x.ts" },
        { id: "2", file: "pkg/b/y.ts" },
        { id: "3", file: "pkg/a/z.ts" },
      ],
      edges: [
        { source: "1", target: "2", type: "imports" },
        { source: "1", target: "3", type: "imports" },
      ],
    });
    const edges = readGraphify(root, moduleOf);
    expect(edges).toEqual([{ from: "pkg/a", to: "pkg/b", weight: 1 }]);
  });

  it("ignores non-import edge types", () => {
    const root = repoWithGraph({
      nodes: [{ id: "1", file: "pkg/a/x.ts" }, { id: "2", file: "pkg/b/y.ts" }],
      edges: [{ source: "1", target: "2", type: "mentions" }],
    });
    expect(readGraphify(root, moduleOf)).toEqual([]);
  });

  it("returns null rather than throwing on malformed json", () => {
    const root = mkdtempSync(join(tmpdir(), "bad-"));
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    writeFileSync(join(root, "graphify-out", "graph.json"), "{not json");
    expect(readGraphify(root, moduleOf)).toBeNull();
  });
});
