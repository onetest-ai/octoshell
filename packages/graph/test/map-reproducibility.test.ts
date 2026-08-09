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
    expect(analysis.modules.length).toBeGreaterThan(1);

    const md = renderMap(analysis, budgetTokens);
    expect(estimateTokens(md)).toBeLessThanOrEqual(budgetTokens);
    expect(md).toContain("# Module map");
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
