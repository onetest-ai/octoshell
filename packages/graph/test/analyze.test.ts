import { describe, expect, it } from "vitest";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { analyze } from "../src/analyze.js";
import { DEFAULTS } from "../src/config.js";

const NOW = Date.UTC(2026, 0, 30);

/** Every path the analysis placed inside some module. */
function placed(modules: { members: string[] }[]): Set<string> {
  return new Set(modules.flatMap((m) => m.members));
}

/**
 * Background churn that touches none of the files under test.
 *
 * It is load-bearing rather than decorative: a file present in *literally*
 * every commit has marginal probability 1, which drives its nPMI to exactly 0
 * and its weighted degree with it, so `detectHubs` never flags it (see
 * e2e.test.ts). Diluting the marginal is what makes hub quarantine fire at all.
 * Each pair is committed twice so it clears the default `minSupport` of 2.
 */
function backgroundChurn(pairs: number): CommitSpec[] {
  const out: CommitSpec[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`] });
    out.push({ files: [`bg/${i}a.ts`, `bg/${i}b.ts`] });
  }
  return out;
}

describe("analyze: hub reattachment", () => {
  it("places a hub whose neighbours all cluster, into the community that voted for it", () => {
    const commits: CommitSpec[] = [];
    // Two dense regions plus a file that rides along with both — the classic
    // hub, and one whose neighbours do have communities of their own.
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1/a.ts", "r1/b.ts", "r1/c.ts", "cfg.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2/a.ts", "r2/b.ts", "r2/c.ts", "cfg.ts"] });
    commits.push(...backgroundChurn(15));

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    expect(analysis.hubs).toContain("cfg.ts");
    expect(placed(analysis.modules).has("cfg.ts")).toBe(true);
  });

  /**
   * The regression this file exists for.
   *
   * A hub is reattached by plurality vote, but only a neighbour that HAS a
   * community can vote — and a neighbour only has one if it kept an edge that
   * touches no hub. In a star (one file committed pairwise with each leaf and
   * nothing else) every leaf's sole edge runs to the hub, so no leaf is in the
   * partition, no vote is cast, and the pre-fix code left `best === -1` and
   * dropped the hub on the floor: quarantined out of clustering, absent from
   * every community, present in the artifact only as a name under `hubs`.
   *
   * That is not a hypothetical shape — it is a config file, a schema, or a
   * generated manifest committed with each consumer in turn.
   */
  it("still places a hub that no community voted for, using its declared module", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 20; i++) {
      commits.push({ files: ["tools/cfg.ts", `leaf/${i}.ts`] });
      commits.push({ files: ["tools/cfg.ts", `leaf/${i}.ts`] });
    }
    commits.push(...backgroundChurn(15));

    const { analysis, spine } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });

    // Precondition: the star centre really is quarantined, and really does get
    // no vote (no leaf of the star reaches a community).
    expect(analysis.hubs).toEqual(["tools/cfg.ts"]);

    expect(placed(analysis.modules).has("tools/cfg.ts")).toBe(true);
    // And it lands in the module the declared spine names for its path, not in
    // whatever cluster happened to be biggest — co-change had no opinion here,
    // so the map must not invent one.
    const home = analysis.modules.find((m) => m.members.includes("tools/cfg.ts"));
    expect(home?.name).toBe(spine.moduleOf("tools/cfg.ts"));
  });
});

describe("analyze: determinism", () => {
  /**
   * Module rows are ordered by size, then by name. The name comparison must be
   * the package's `compare` (UTF-16 code units), never `localeCompare`:
   *
   *  - `localeCompare` collates by the machine's default locale, so the
   *    committed artifact would reorder on nothing but a change of LANG
   *    ("pkg/aa" sorts before "pkg/z" in en-US and after it in da-DK).
   *  - It disagrees with code-unit order on this very machine wherever case is
   *    involved — it puts "alpha" before "Zed", code units put "Zed" first — so
   *    the module list would contradict the `Spine.modules`, `rollUp` and
   *    `readGraphify` lists rendered beside it.
   *
   * Two equal-sized regions in capitalised and lowercase directories put those
   * two rules on opposite sides of the tie-break.
   */
  it("orders equal-sized modules by code unit, not by locale collation", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["Zed/a.ts", "Zed/b.ts", "Zed/c.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["alpha/a.ts", "alpha/b.ts", "alpha/c.ts"] });

    const { analysis } = analyze(buildRepo(commits), DEFAULTS, { now: NOW });
    const names = analysis.modules.map((m) => m.name);
    expect(names).toContain("Zed");
    expect(names).toContain("alpha");
    // Equal member counts, so the tie-break alone decides. localeCompare would
    // emit ["alpha", "Zed"].
    expect(names.indexOf("Zed")).toBeLessThan(names.indexOf("alpha"));
  });

  it("two runs over one repo produce identical analyses", () => {
    const commits: CommitSpec[] = [];
    for (let i = 0; i < 8; i++) commits.push({ files: ["r1/a.ts", "r1/b.ts", "r1/c.ts", "cfg.ts"] });
    for (let i = 0; i < 8; i++) commits.push({ files: ["r2/a.ts", "r2/b.ts", "r2/c.ts", "cfg.ts"] });
    commits.push(...backgroundChurn(15));

    const repo = buildRepo(commits);
    const first = analyze(repo, DEFAULTS, { now: NOW });
    const second = analyze(repo, DEFAULTS, { now: NOW });
    expect(JSON.stringify(second.analysis)).toBe(JSON.stringify(first.analysis));
  });
});
