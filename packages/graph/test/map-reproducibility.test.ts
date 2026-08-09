import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { analyze } from "../src/analyze.js";
import { estimateTokens, renderMap } from "../src/render.js";
import { DEFAULTS, type Config } from "../src/config.js";

const NOW = Date.UTC(2026, 0, 30);

describe("end-to-end: map.md regenerates byte-identically from an unchanged commit", () => {
  it("two full analyze+render passes over the same HEAD produce the exact same bytes", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/a/x.ts", "pkg/a/y.ts"] });
    for (let i = 0; i < 6; i++) commits.push({ files: ["pkg/b/x.ts", "pkg/b/y.ts"] });
    const root = buildRepo(commits);

    const first = analyze(root, DEFAULTS, { now: NOW });
    const second = analyze(root, DEFAULTS, { now: NOW });
    const mdFirst = renderMap(first.analysis, DEFAULTS.budgetTokens);
    const mdSecond = renderMap(second.analysis, DEFAULTS.budgetTokens);

    // Not merely equal content — byte-identical, since map.md is a committed
    // artifact and a stray whitespace or ordering difference would show up as
    // diff noise on every unrelated run.
    expect(mdSecond).toBe(mdFirst);
  });

  /**
   * The test above re-runs a pure computation over byte-identical inputs, so it
   * is green for ANY implementation that does not read a clock, an RNG, or the
   * environment — including one whose output order is a function of `Map`
   * insertion order, because insertion order is itself reproduced exactly by
   * the second run. It therefore cannot see the determinism defect that
   * actually threatens a committed artifact: an iteration order that reaches
   * output without being explicitly sorted, which is stable within a machine
   * and differs across repos, clones and contributors.
   *
   * Measured, not assumed: deleting the module-name tie-break from `analyze`'s
   * module sort (`b[1].length - a[1].length || compare(a[0], b[0])`) leaves the
   * test above green and turns this one red.
   *
   * The permutation is the whole point. Commits carry no per-commit date here
   * (all default to the same timestamp), so reversing history leaves every
   * decayed weight, support count and nPMI numerically identical and changes
   * exactly one thing: the order in which `harvest` discovers files, and so
   * every node id, `Map` insertion order and `Set` iteration order downstream.
   * Any ordering that reaches map.md and is not explicitly sorted moves.
   */
  it("renders the same bytes for the same history discovered in a different order", () => {
    const modules = ["a", "b", "c", "d"];
    const commits: CommitSpec[] = [];
    for (const name of modules) {
      for (let i = 0; i < 5; i++) {
        commits.push({ files: [`pkg/${name}/x.ts`, `pkg/${name}/y.ts`, `pkg/${name}/z.ts`] });
      }
    }
    // Cross-module churn, so the Dependencies section is non-empty and the
    // comparison covers module-edge ordering too, not just module headings.
    for (let i = 0; i < modules.length; i++) {
      const from = modules[i];
      const to = modules[(i + 1) % modules.length];
      if (from === undefined || to === undefined) throw new Error("bad fixture");
      for (let k = 0; k < 3; k++) {
        commits.push({ files: [`pkg/${from}/x.ts`, `pkg/${to}/y.ts`] });
      }
    }

    const forward = buildRepo(commits);
    const reversed = buildRepo([...commits].reverse());
    for (const root of [forward, reversed]) {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'pkg/*'\n");
      for (const name of modules) {
        writeFileSync(join(root, `pkg/${name}/package.json`), `{"name":"${name}"}\n`);
      }
    }

    const first = analyze(forward, DEFAULTS, { now: NOW });
    const second = analyze(reversed, DEFAULTS, { now: NOW });

    // Preconditions — without these the assertion below is satisfied by any
    // implementation at all, which is exactly the failure mode this test was
    // added to close. The permutation must really have reached the engine...
    expect(second.files).not.toEqual(first.files);
    // ...the two runs must really describe the same repo...
    expect([...second.files].sort()).toEqual([...first.files].sort());
    // ...and both sections of the map must really have content to order.
    expect(first.analysis.modules.length).toBeGreaterThan(1);
    expect(first.analysis.moduleEdges.length).toBeGreaterThan(0);

    const mdFirst = renderMap(first.analysis, DEFAULTS.budgetTokens);
    const mdSecond = renderMap(second.analysis, DEFAULTS.budgetTokens);
    expect(mdSecond).toBe(mdFirst);
  });
});

describe("end-to-end: map.md stays within its token budget on a real, edge-heavy repo", () => {
  it("truncates modules and dependency edges together so a small budget is still honoured", () => {
    // Sixteen tiny modules, each internally paired, so Louvain resolves
    // sixteen communities and rollUp's module-edge count grows with the
    // cross-module churn below — enough real content that an untrimmed
    // render would blow a modest budget, exactly the shape the truncation
    // loop in render.ts exists to bound.
    const commits: CommitSpec[] = [];
    const names = Array.from({ length: 16 }, (_, i) => `m${i}`);
    for (const name of names) {
      for (let i = 0; i < 4; i++) {
        commits.push({ files: [`pkg/${name}/x.ts`, `pkg/${name}/y.ts`] });
      }
    }
    // Sparse cross-module churn: each module co-changes once with the next,
    // which is enough to seed a moduleEdges row per pair without merging
    // any two modules' communities together.
    for (let i = 0; i < names.length - 1; i++) {
      commits.push({ files: [`pkg/${names[i]}/x.ts`, `pkg/${names[i + 1]}/x.ts`] });
      commits.push({ files: [`pkg/${names[i]}/x.ts`, `pkg/${names[i + 1]}/x.ts`] });
    }
    const root = buildRepo(commits);

    const budgetTokens = 200;
    const config: Config = { ...DEFAULTS, budgetTokens };
    const { analysis } = analyze(root, config, { now: NOW });

    // Precondition: there is real content to trim, not an already-tiny map.
    // `modules.length > 1` alone does NOT establish that — a map that already
    // fits satisfies the budget assertion below for every implementation,
    // including one that ignores the budget entirely. Pin the fixture as
    // genuinely over budget by rendering it unbounded first.
    expect(analysis.modules.length).toBeGreaterThan(1);
    expect(analysis.moduleEdges.length).toBeGreaterThan(0);
    const untrimmed = renderMap(analysis, Number.MAX_SAFE_INTEGER);
    expect(estimateTokens(untrimmed)).toBeGreaterThan(budgetTokens);

    const md = renderMap(analysis, budgetTokens);
    expect(estimateTokens(md)).toBeLessThanOrEqual(budgetTokens);
    expect(md).toContain("# Module map");

    // Both sections give something up. Trimming only the module list leaves
    // the dependency list — which is quadratic in the module count — whole,
    // and that is the specific regression the truncation loop in render.ts
    // exists to prevent; asserting the budget alone cannot see it, since
    // dropping every module line also gets under the budget.
    expect(md).toContain("module(s) truncated to fit the token budget.");
    expect(md).toContain("coupling edge(s) truncated to fit the token budget.");

    // And the trim leaves the map internally consistent. `analyze` guarantees
    // every module a `moduleEdges` row names has a heading of its own (see
    // analyze.test.ts's `expectNoDanglingModuleEdges`) — but that invariant is
    // stated over `Analysis`, and the budget loop runs after it. Trimming the
    // module list and the edge list independently reopened it in the one place
    // it matters: the committed markdown. Measured on this exact fixture, the
    // pre-fix render named `pkg/m2` and `pkg/m9` in the Coupling section with
    // no heading anywhere in the file.
    const headings = new Set([...md.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]));
    const endpoints = [...md.matchAll(/^- (\S+) [↔→] (\S+) \(/gm)].flatMap((m) => [m[1], m[2]]);
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.filter((e) => !headings.has(e))).toEqual([]);
  });
});

describe("end-to-end: two communities resolving to one declared module render as one heading", () => {
  it("merges two Louvain communities under a single package boundary into a single module row", () => {
    // Two dense, mutually disconnected file cliques — exactly the shape that
    // resolves to two separate Louvain communities (see e2e.test.ts's
    // twoRegionCommits) — but both living under the SAME manifest package.
    // Declared and discovered structure disagreeing here is the expected
    // case, not a bug: the map must render one heading, not two.
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 10; i++) {
      commits.push({ files: ["pkg/big/sub1/a.ts", "pkg/big/sub1/b.ts", "pkg/big/sub1/c.ts"] });
    }
    for (let i = 0; i < 10; i++) {
      commits.push({ files: ["pkg/big/sub2/x.ts", "pkg/big/sub2/y.ts", "pkg/big/sub2/z.ts"] });
    }
    const root = buildRepo(commits);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'pkg/*'\n");
    writeFileSync(join(root, "pkg/big/package.json"), '{"name":"big"}\n');

    const { analysis, spine } = analyze(root, DEFAULTS, { now: NOW });
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("pkg/big/sub1/a.ts")).toBe("pkg/big");
    expect(spine.moduleOf("pkg/big/sub2/x.ts")).toBe("pkg/big");

    const bigModules = analysis.modules.filter((m) => m.name === "pkg/big");
    expect(bigModules).toHaveLength(1);
    const [big] = bigModules;
    if (big === undefined) throw new Error("expected exactly one pkg/big module");
    expect(big.members.sort()).toEqual(
      [
        "pkg/big/sub1/a.ts",
        "pkg/big/sub1/b.ts",
        "pkg/big/sub1/c.ts",
        "pkg/big/sub2/x.ts",
        "pkg/big/sub2/y.ts",
        "pkg/big/sub2/z.ts",
      ].sort(),
    );

    // And the rendered map carries exactly one heading for it too — the merge
    // is not undone (or duplicated) between Analysis and the markdown.
    const md = renderMap(analysis, DEFAULTS.budgetTokens);
    const headingMatches = md.match(/\*\*pkg\/big\*\*/g) ?? [];
    expect(headingMatches).toHaveLength(1);
  });
});
