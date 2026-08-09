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

  // `null` is valid JSON, so it clears the try/catch and reaches the property
  // read. A failed or empty Graphify run leaving one behind must degrade the
  // spine, not take the whole map generation down with a TypeError.
  it.each(["null", "123", '"a string"'])(
    "returns null rather than throwing when graph.json holds the bare value %s",
    (body) => {
      const root = mkdtempSync(join(tmpdir(), "bare-"));
      mkdirSync(join(root, "graphify-out"), { recursive: true });
      writeFileSync(join(root, "graphify-out", "graph.json"), body);
      expect(() => readGraphify(root, moduleOf)).not.toThrow();
      expect(readGraphify(root, moduleOf)).toBeNull();
    },
  );

  it("drops edges whose endpoints name no known node", () => {
    const root = repoWithGraph({
      nodes: [{ id: "1", file: "pkg/a/x.ts" }],
      edges: [{ source: "1", target: "ghost", type: "imports" }],
    });
    expect(readGraphify(root, moduleOf)).toEqual([]);
  });

  // `Spine.modules` is ordered by plain `.sort()`, i.e. UTF-16 code units.
  // `localeCompare` disagrees with that on this very machine wherever case is
  // involved — it puts "alpha/b" before "Zed/a", code units put "Zed/a" first —
  // so an edge list sorted by locale is inconsistent with the module list
  // beside it in any repo holding a capitalized module directory.
  it("orders edges by code unit, not by locale collation", () => {
    const root = repoWithGraph({
      nodes: [
        { id: "z", file: "Zed/a/x.ts" },
        { id: "a", file: "alpha/b/y.ts" },
        { id: "t", file: "common/c/z.ts" },
      ],
      edges: [
        { source: "a", target: "t", type: "imports" },
        { source: "z", target: "t", type: "imports" },
      ],
    });
    expect(readGraphify(root, moduleOf)?.map((e) => e.from)).toEqual(["Zed/a", "alpha/b"]);
  });

  // Graphify's paths are the one part of its output that reaches a committed
  // artifact, so they must land in the same repo-relative namespace `harvest`
  // reads out of git.
  it("drops nodes whose path escapes the repo root", () => {
    const root = repoWithGraph({
      nodes: [
        { id: "1", file: "../../secrets/a/x.ts" },
        { id: "2", file: "pkg/b/y.ts" },
      ],
      edges: [{ source: "1", target: "2", type: "imports" }],
    });
    // Never an edge out of a module named "../..".
    expect(readGraphify(root, moduleOf)).toEqual([]);
  });

  it("normalizes absolute in-repo paths so modules are not named for the checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "abs-"));
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    writeFileSync(
      join(root, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "1", file: join(root, "pkg/a/x.ts") },
          { id: "2", file: join(root, "pkg/b/y.ts") },
        ],
        edges: [{ source: "1", target: "2", type: "imports" }],
      }),
    );
    // Not [{ from: "/private", to: ... }] or any other machine-dependent name.
    expect(readGraphify(root, moduleOf)).toEqual([{ from: "pkg/a", to: "pkg/b", weight: 1 }]);
  });
});
