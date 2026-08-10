import { describe, expect, it } from "vitest";
import { estimateTokens, renderMap } from "../src/render.js";
import type { Analysis } from "../src/analyze.js";
import type { WorkingSet } from "../src/working-sets.js";

const analysis: Analysis = {
  commitCount: 400,
  fileCount: 120,
  spineSource: "manifests",
  modules: [
    { id: 0, name: "packages/board", members: ["packages/board/src/a.ts"], layer: 1 },
    { id: 1, name: "apps/ext", members: ["apps/ext/src/b.ts"], layer: 0 },
  ],
  moduleEdges: [{ from: "apps/ext", to: "packages/board", weight: 3.2 }],
  moduleEdgesDirected: false,
  hubs: ["package.json"],
  bridged: 0,
  clusterIds: { kept: 2, fresh: 0 },
  workingSets: [],
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
    // The fixture's spine is `manifests`, so these are undirected co-change
    // edges, not declared dependencies — see module-edge-direction.test.ts.
    expect(md).toContain("coupling edge(s) truncated");
    // Trimming must not starve one section to pay for the other: the single
    // module survives a cut that drops hundreds of edges.
    expect(md).toContain("pkg/only");
  });

  it("degrades to the header rather than looping when the budget is unreachably small", () => {
    const md = renderMap(analysis, 1);
    expect(md).toContain("# Module map");
    expect(md).not.toContain("packages/board");
  });

  /**
   * `modules[].members` counts files that survived `harvest`'s pair-bearing-
   * commit filter, not "every file in the module" — a file only ever touched
   * by single-file commits never reaches `table.files` at all and so is
   * invisible to this count. The per-module line must say what it counts
   * instead of reading as a total, and the header must tell a reader such
   * files are omitted, or they are left wondering where roughly half a real
   * repo's tracked files went.
   */
  it("labels the per-module count as co-changed files, not a module total", () => {
    const md = renderMap(analysis, 2000);
    expect(md).toContain("**packages/board** [layer 1] — 1 co-changed files");
    expect(md).toContain("**apps/ext** [layer 0] — 1 co-changed files");
  });

  it("tells the reader that solo-commit files are absent from the graph entirely", () => {
    const md = renderMap(analysis, 2000);
    expect(md).toContain("- files never co-changed with another file: omitted below");
  });

  /**
   * Spec A8 (amended 2026-08-10): test files stay in `members`, so the
   * per-module count must distinguish source from test rather than presenting
   * one mixed total — a mixed total is the file-count defect over again, a
   * number true of nothing a reader would name.
   */
  describe("A8: source/test split in the per-module count", () => {
    it("reports both parts, with correct numbers, for a module with source and test members", () => {
      const mixed: Analysis = {
        ...analysis,
        modules: [
          {
            id: 0,
            name: "packages/board",
            members: [
              "packages/board/src/a.ts",
              "packages/board/src/b.ts",
              "packages/board/test/a.test.ts",
            ],
            layer: 1,
          },
        ],
      };
      const md = renderMap(mixed, 2000);
      expect(md).toContain("**packages/board** [layer 1] — 2 source, 1 test co-changed files");
    });

    it("renders no '0 test' noise for a module with no test members — the common case", () => {
      const md = renderMap(analysis, 2000);
      // Existing, unmodified wording for the all-source case (pinned above)
      // must still hold, and must not gain a spurious "0 test" clause.
      expect(md).toContain("**packages/board** [layer 1] — 1 co-changed files");
      expect(md).not.toContain("0 test");
    });

    it("names an all-test module explicitly, rather than omitting the zero source count", () => {
      const allTest: Analysis = {
        ...analysis,
        modules: [
          {
            id: 0,
            name: "packages/board",
            members: ["packages/board/test/a.test.ts", "packages/board/test/b.test.ts"],
            layer: 1,
          },
        ],
      };
      const md = renderMap(allTest, 2000);
      expect(md).toContain("**packages/board** [layer 1] — 0 source, 2 test co-changed files");
    });
  });

  /**
   * `Analysis.fileCount` is `PairTable.files.length` — the files that appear in
   * an analysable commit touching two or more paths, which on this repo is a
   * third of the tracked tree. Rendered as a bare "files: N" it reads as a repo
   * total, which is the same partial-presented-as-total failure the
   * "never co-changed" header line already guards for the Modules section.
   */
  it("scopes the header file count to the graph rather than implying a repo total", () => {
    const md = renderMap(analysis, 2000);
    expect(md).toContain("- files in the co-change graph: 120");
    expect(md).not.toMatch(/^- files: /m);
  });

  /**
   * A module row's members are that module's DECLARED membership
   * (`filesByModule`), not the Louvain community that won the row's name —
   * `analyze` names a row for its community's most central file, but a
   * community can sweep in files declared under a different module (measured
   * on this repo before the fix: three of `packages/tokenomics`' four listed
   * members were `apps/vscode-extension` files). Without a scope line the
   * count reads as "this module contains N files" without saying whose N.
   */
  it("states what a module row's file count actually counts", () => {
    const md = renderMap(analysis, 2000);
    expect(md).toContain("declared module's own membership");
    expect(md).toContain("declared rows instead");
  });

  /**
   * The parenthesised number means a count of declared import edges on the
   * Graphify tier and a sum of decayed nPMI on the co-change tier — different
   * quantities on different scales in the same rendered position.
   */
  it("names the unit of the edge weight, per tier", () => {
    expect(renderMap(analysis, 2000)).toContain("Weight is summed decayed nPMI");
    expect(renderMap({ ...analysis, moduleEdgesDirected: true }, 2000)).toContain(
      "Weight is the number of declared import edges",
    );
  });

  /**
   * The regression this block exists for (M2 whole-mission review).
   *
   * `analyze` guarantees every module a `moduleEdges` row names has a heading of
   * its own — the invariant its module-identity backstop exists for, pinned by
   * `expectNoDanglingModuleEdges` in analyze.test.ts. That invariant is stated
   * over `Analysis`, so nothing saw the renderer reopen it: the budget loop
   * trimmed the module list and the edge list independently, so a rendered edge
   * could name a module whose heading had just been cut. map.md is the
   * committed artifact and an agent's architecture context — the dangling
   * reference lands there, not in the in-memory analysis.
   */
  it("never renders an edge whose endpoint was truncated out of the Modules section", () => {
    const many: Analysis = {
      ...analysis,
      // Equal-sized modules, so the budget cuts strictly from the tail.
      modules: Array.from({ length: 16 }, (_, i) => ({
        id: i,
        name: `pkg/m${i}`,
        members: [`pkg/m${i}/x.ts`],
        layer: null,
      })),
      // Edges deliberately naming modules deep in the tail, at weights that
      // keep them at the head of the edge list — exactly the shape where the
      // two independent trims disagree.
      moduleEdges: [
        { from: "pkg/m0", to: "pkg/m15", weight: 9.5 },
        { from: "pkg/m1", to: "pkg/m14", weight: 9.4 },
        { from: "pkg/m2", to: "pkg/m13", weight: 9.3 },
      ],
    };

    const budget = 190;
    // Precondition: the map really is over budget, so the trim really runs.
    expect(estimateTokens(renderMap(many, Number.MAX_SAFE_INTEGER))).toBeGreaterThan(budget);

    const md = renderMap(many, budget);
    expect(estimateTokens(md)).toBeLessThanOrEqual(budget);

    const headings = new Set([...md.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]));
    // Precondition: modules really were dropped — otherwise nothing can dangle
    // and this assertion is satisfied by any implementation at all.
    expect(headings.size).toBeLessThan(many.modules.length);

    const endpoints = [...md.matchAll(/^- (\S+) [↔→] (\S+) \(/gm)].flatMap((m) => [m[1], m[2]]);
    expect(endpoints.filter((e) => !headings.has(e))).toEqual([]);
  });

  /**
   * Fixture updated for the PageRank truncation fix (M2 bug: spec A9).
   *
   * The original fixture connected exactly one pair of modules by one edge
   * among many fully isolated peers — a shape a real centrality ranking
   * cannot ever hide, because a single edge always outranks zero edges,
   * regardless of the edge's own weight (a two-node component's PageRank
   * doesn't depend on the magnitude of its one edge; weight only matters when
   * a node has to split its rank across more than one neighbour). A `hub`
   * genuinely more central than `pkg/m0`/`pkg/m15` — connected to three
   * spokes rather than one peer — is what lets the budget cut a real edge's
   * endpoint while a more central one survives, which is the invariant this
   * test exists to pin: an edge hidden because its endpoint lost the
   * truncation cut is still counted, never silently dropped.
   */
  it("counts an edge hidden with its module against the truncation note", () => {
    const hub = { id: 0, name: "pkg/hub", members: ["pkg/hub/x.ts"], layer: null };
    const spokes = Array.from({ length: 3 }, (_, i) => ({
      id: 1 + i,
      name: `pkg/spoke-${i}`,
      members: [`pkg/spoke-${i}/x.ts`],
      layer: null,
    }));
    const pair = ["pkg/m0", "pkg/m15"].map((name, i) => ({
      id: 10 + i,
      name,
      members: [`${name}/x.ts`],
      layer: null,
    }));
    const isolated = Array.from({ length: 10 }, (_, i) => ({
      id: 20 + i,
      name: `pkg/iso-${i}`,
      members: [`pkg/iso-${i}/x.ts`],
      layer: null,
    }));

    const many: Analysis = {
      ...analysis,
      modules: [hub, ...spokes, ...pair, ...isolated],
      moduleEdges: [
        { from: "pkg/hub", to: "pkg/spoke-0", weight: 50 },
        { from: "pkg/hub", to: "pkg/spoke-1", weight: 50 },
        { from: "pkg/hub", to: "pkg/spoke-2", weight: 50 },
        { from: "pkg/m0", to: "pkg/m15", weight: 9.5 },
      ],
    };

    const md = renderMap(many, 228);
    // `pkg/spoke-2` is the one truncated out — the reader is told its edge
    // is missing rather than left to assume there were none.
    expect(md).toContain("1 coupling edge(s) truncated to fit the token budget.");
  });

  /**
   * The regression this block exists for (M2 bug: spec A9 requires descending
   * PageRank, render.ts truncated by member count).
   *
   * `hub` has only one member but is strongly coupled to three other modules
   * — the small, heavily-depended-on module spec A9 exists to keep visible.
   * `leaf-0`..`leaf-4` each have many members but zero moduleEdges — bulk
   * with no centrality at all. Fixture order mirrors what `analyze()` itself
   * produces (member count descending, then `compare(name)`), so a
   * member-count-ranked truncation — the pre-fix behaviour — cuts `hub` long
   * before any `leaf-*` row, exactly backwards from what the map exists to
   * convey.
   */
  it("keeps a small, central module and drops a large, disconnected one when truncating", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      name: `leaf-${i}`,
      members: Array.from({ length: 6 }, (_, j) => `leaf-${i}/f${j}.ts`),
      layer: null,
    }));
    const spokes = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      name: `spoke-${i}`,
      members: [`spoke-${i}/x.ts`],
      layer: null,
    }));
    const hub = { id: 200, name: "hub", members: ["hub/x.ts"], layer: null };

    const central: Analysis = {
      ...analysis,
      // Member-count descending, then name — the order `analyze()` actually
      // produces. `hub` (1 member) sorts before the alphabetically later
      // spokes, but after every 6-member leaf.
      modules: [...leaves, hub, ...spokes],
      moduleEdges: [
        { from: "hub", to: "spoke-0", weight: 50 },
        { from: "hub", to: "spoke-1", weight: 50 },
        { from: "hub", to: "spoke-2", weight: 50 },
      ],
    };

    // Chosen so member-count-ranked truncation (the pre-fix behaviour) lands
    // exactly on the boundary between the 5 leaves and `hub`: all 5 leaves
    // fit, `hub` (and every spoke) does not.
    const budget = 205;
    // Precondition: there is real content to trim.
    expect(estimateTokens(renderMap(central, Number.MAX_SAFE_INTEGER))).toBeGreaterThan(budget);
    // Precondition: member-count order really does put `hub` behind every
    // leaf — otherwise this fixture can't distinguish the two rankings.
    const byCount = [...central.modules].sort((a, b) => b.members.length - a.members.length);
    expect(byCount.slice(0, leaves.length).every((m) => m.name.startsWith("leaf-"))).toBe(true);
    expect(byCount.findIndex((m) => m.name === "hub")).toBe(leaves.length);

    const md = renderMap(central, budget);
    expect(md).toContain("**hub**");
    // At least one large, disconnected leaf must not survive the cut — bulk
    // alone is not centrality.
    const survivingLeaves = leaves.filter((l) => md.includes(`**${l.name}**`));
    expect(survivingLeaves.length).toBeLessThan(leaves.length);
  });

  /**
   * T7.3: the read-only "discovered delta" section (spec D3). `analysis.
   * workingSets` is already suppressed to `[]` at the analysis layer (T7.2)
   * whenever history is too thin to cluster, so the renderer's only job is:
   * say nothing when there is nothing, and when there IS something, say
   * exactly what was observed — never a recommendation.
   */
  describe("Working sets", () => {
    it("omits the section entirely when there are no working sets", () => {
      const out = renderMap({ ...analysis, workingSets: [] }, 4000);
      expect(out).not.toContain("## Working sets");
    });

    it("names the modules a working set spans and lists its files", () => {
      const sets: WorkingSet[] = [
        { name: "a/x.ts", modules: ["apps/ext", "packages/board"], files: ["a/x.ts", "b/y.ts"] },
      ];
      const out = renderMap({ ...analysis, workingSets: sets }, 4000);
      expect(out).toContain("## Working sets");
      expect(out).toContain("2 files across apps/ext, packages/board");
      expect(out).toContain("  - a/x.ts");
      expect(out).toContain("  - b/y.ts");
    });

    it("states no recommendation", () => {
      const sets: WorkingSet[] = [
        { name: "a/x.ts", modules: ["apps/ext", "packages/board"], files: ["a/x.ts", "b/y.ts"] },
      ];
      const out = renderMap({ ...analysis, workingSets: sets }, 4000);
      const section = out.slice(out.indexOf("## Working sets")).toLowerCase();
      for (const word of ["should", "consider", "recommend", "merge these", "split", "refactor"]) {
        expect(section).not.toContain(word);
      }
    });

    it("is byte-identical across runs when working sets are present", () => {
      const sets: WorkingSet[] = [
        { name: "a/x.ts", modules: ["apps/ext", "packages/board"], files: ["a/x.ts", "b/y.ts"] },
      ];
      const withSets = { ...analysis, workingSets: sets };
      expect(renderMap(withSets, 4000)).toBe(renderMap(withSets, 4000));
    });

    /**
     * Criterion 4 / criterion 6 (dangling reference), restated at this new
     * surface exactly as `visibleEdges`' own regression block does above for
     * edges. `analyze` never guarantees a working set's modules survive the
     * budget — only `analyze.test.ts`'s module-identity backstop guarantees
     * that for edge endpoints — so this invariant is entirely `render.ts`'s
     * to hold: a working set naming a module whose heading the budget just
     * cut is a dangling reference in the committed artifact.
     */
    it("never renders a working set naming a module truncated out of the Modules section", () => {
      const many: Analysis = {
        ...analysis,
        // Equal-sized modules, so the budget cuts strictly from the tail —
        // same shape as the edge dangling-reference fixture above.
        modules: Array.from({ length: 16 }, (_, i) => ({
          id: i,
          name: `pkg/m${i}`,
          members: [`pkg/m${i}/x.ts`],
          layer: null,
        })),
        moduleEdges: [],
        // Spans a module deep in the tail, so a budget that keeps only the
        // head of the module list must also drop this set.
        workingSets: [
          {
            name: "pkg/m15/x.ts",
            modules: ["pkg/m0", "pkg/m15"],
            files: ["pkg/m0/x.ts", "pkg/m15/x.ts"],
          },
        ],
      };

      const budget = 190;
      // Precondition: the map really is over budget, so the trim really runs.
      expect(estimateTokens(renderMap(many, Number.MAX_SAFE_INTEGER))).toBeGreaterThan(budget);

      const md = renderMap(many, budget);
      expect(estimateTokens(md)).toBeLessThanOrEqual(budget);

      const headings = new Set([...md.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]));
      // Precondition: pkg/m15 really was dropped — otherwise nothing can
      // dangle and this assertion is satisfied by any implementation at all.
      expect(headings.has("pkg/m15")).toBe(false);
      expect(md).not.toContain("## Working sets");
    });

    /**
     * The enforcement test for "slice by SET, never by line" (task brief):
     * whatever budget renders a working set at all, the file count its
     * header claims must equal the member lines actually shown beneath it —
     * never a header claiming "N files" above fewer than N lines.
     */
    it("never renders a working set header above a partial file list", () => {
      const bigSet: WorkingSet = {
        name: "pkg/big/x.ts",
        modules: ["apps/ext", "packages/board"],
        files: Array.from({ length: 50 }, (_, i) => `pkg/big/file-${i}.ts`),
      };
      const out = renderMap({ ...analysis, workingSets: [bigSet] }, 4000);
      const header = out.match(/- \*\*.+\*\* — (\d+) files across /);
      expect(header).not.toBeNull();
      const claimed = Number(header?.[1]);
      const rendered = out
        .slice(out.indexOf(header?.[0] ?? ""))
        .split("\n")
        .slice(1)
        .filter((l) => l.startsWith("  - ")).length;
      expect(rendered).toBe(claimed);
    });

    it("stays within the token budget when the working sets section is the large one", () => {
      const heavySets: WorkingSet[] = Array.from({ length: 40 }, (_, i) => ({
        name: `pkg/set-${i}/x.ts`,
        modules: ["apps/ext", "packages/board"],
        files: Array.from({ length: 10 }, (_, j) => `pkg/set-${i}/file-${j}.ts`),
      }));
      const heavy: Analysis = { ...analysis, workingSets: heavySets };

      const budget = 500;
      // Precondition: the map really is over budget, so the trim really runs.
      expect(estimateTokens(renderMap(heavy, Number.MAX_SAFE_INTEGER))).toBeGreaterThan(budget);

      const md = renderMap(heavy, budget);
      expect(estimateTokens(md)).toBeLessThanOrEqual(budget);
      // Trimming the sets list must not starve the modules it names.
      expect(md).toContain("packages/board");
      expect(md).toContain("apps/ext");
      expect(md).toContain("working set(s) truncated");
      expect(renderMap(heavy, budget)).toBe(renderMap(heavy, budget));
    });
  });
});
