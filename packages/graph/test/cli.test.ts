import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { appendCommits, buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const NOW = Date.UTC(2026, 0, 1);

/** A minimal repo — enough for parse-time failures, which never reach git. */
function tinyRepo(): string {
  return buildRepo([{ files: ["a.ts", "b.ts"] }]);
}

describe("runCli — flag parsing", () => {
  it("exits 2 on an unrecognised flag rather than silently ignoring it", () => {
    // The regression this guards: deriving `--half-life-days` from the
    // `halfLifeDays` config key instead of declaring `--half-life`
    // explicitly. That flag must be REJECTED, not accepted as a synonym.
    const result = runCli(["doctor", "--half-life-days", "90"], tinyRepo(), NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--half-life-days");
  });

  it("exits 2 with no command given", () => {
    expect(runCli([], tinyRepo(), NOW).code).toBe(2);
  });

  it("exits 2 on an unknown command", () => {
    expect(runCli(["frobnicate"], tinyRepo(), NOW).code).toBe(2);
  });

  it("exits 2 when impact is given no <path> argument", () => {
    expect(runCli(["impact"], tinyRepo(), NOW).code).toBe(2);
  });

  it("exits 2 when a value-taking flag is given no value", () => {
    const result = runCli(["doctor", "--min-commits"], tinyRepo(), NOW);
    expect(result.code).toBe(2);
  });

  it("names an unrecognised flag as unrecognised even when it is last on the line", () => {
    // The regression: the value lookup used to run ABOVE the switch, so a
    // flag nothing recognises was reported as `--verbose requires a value`
    // whenever nothing followed it — an error message asserting that
    // `--verbose` is a real flag of this CLI. Exit 2 either way, which is why
    // an exit-code-only assertion (the one this suite already had, two cases
    // up) cannot see it.
    const last = runCli(["doctor", "--verbose"], tinyRepo(), NOW);
    expect(last.code).toBe(2);
    expect(last.stderr).toContain("unrecognised flag: --verbose");
    expect(last.stderr).not.toContain("requires a value");

    // Same verdict, same wording, whether or not a token follows it.
    const followed = runCli(["doctor", "--verbose", "1"], tinyRepo(), NOW);
    expect(followed.stderr).toContain("unrecognised flag: --verbose");
  });

  it("refuses to swallow the next flag as a value", () => {
    // `map --out --json` used to consume `--json` as the out directory: the
    // artifacts landed in a directory literally named `--json` and the
    // documented `--json` flag was silently dropped — the exact quiet
    // failure explicit flag declaration exists to prevent.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["map", "--out", "--json"], repo, NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out requires a value");
    expect(existsSync(join(repo, "--json"))).toBe(false);
  });

  it("exits 2 when a numeric flag is given a non-numeric value", () => {
    const result = runCli(["doctor", "--min-commits", "not-a-number"], tinyRepo(), NOW);
    expect(result.code).toBe(2);
  });
});

describe("runCli — each documented flag changes the behaviour it names", () => {
  it("--json switches doctor's output from human text to parseable JSON", () => {
    const repo = tinyRepo();
    const human = runCli(["doctor"], repo, NOW);
    expect(human.stdout.startsWith("status:")).toBe(true);
    expect(() => JSON.parse(human.stdout)).toThrow();

    const json = runCli(["doctor", "--json"], repo, NOW);
    const parsed = JSON.parse(json.stdout) as { status: string; checks: unknown[] };
    expect(["ok", "degraded", "blocked"]).toContain(parsed.status);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it("--min-commits changes doctor's ok/degraded verdict for the same history", () => {
    const repo = buildRepo(Array.from({ length: 5 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })));

    const withDefault = runCli(["doctor", "--json"], repo, NOW);
    expect(JSON.parse(withDefault.stdout).status).toBe("degraded");

    const withOverride = runCli(["doctor", "--min-commits", "3", "--json"], repo, NOW);
    expect(JSON.parse(withOverride.stdout).status).toBe("ok");
  });

  it("--min-support changes which co-changed pair clears the noise floor", () => {
    // x/y co-change exactly once — below the default minSupport of 2, so no
    // edge survives `weighEdges` at all and `impact` reports nothing.
    const repo = buildRepo([{ files: ["x.ts", "y.ts"] }, { files: ["p.ts", "q.ts"] }]);

    const withDefault = runCli(["impact", "x.ts", "--json"], repo, NOW);
    expect(JSON.parse(withDefault.stdout)).toEqual([]);

    const withOverride = runCli(["impact", "x.ts", "--min-support", "1", "--json"], repo, NOW);
    const rows = JSON.parse(withOverride.stdout) as Array<{ path: string }>;
    expect(rows.some((r) => r.path === "y.ts")).toBe(true);
  });

  it("--max-commit-files drops a mega-commit's pairs from the graph entirely", () => {
    // p/q co-change twice, but only inside 5-file commits. A low
    // `--max-commit-files` drops the WHOLE commit (harvest.ts), not just
    // the extra files, so the pair vanishes rather than just losing support.
    const repo = buildRepo([
      { files: ["p.ts", "q.ts", "x1.ts", "x2.ts", "x3.ts"] },
      { files: ["p.ts", "q.ts", "x1.ts", "x2.ts", "x3.ts"], daysAgo: 1 },
    ]);

    const withDefault = runCli(["impact", "p.ts", "--json"], repo, NOW);
    const defaultRows = JSON.parse(withDefault.stdout) as Array<{ path: string }>;
    expect(defaultRows.some((r) => r.path === "q.ts")).toBe(true);

    const withOverride = runCli(["impact", "p.ts", "--max-commit-files", "3", "--json"], repo, NOW);
    expect(JSON.parse(withOverride.stdout)).toEqual([]);
  });

  it("--half-life changes how much a stale pairing's weight decays", () => {
    // a/b pair recently; a/old paired equally often (support 2 each) but
    // 720 days ago. The noise commits keep `a`'s own marginal weight from
    // saturating to ~1 (it would otherwise touch every commit in the
    // fixture and nPMI would read ~0 for BOTH half-lives, hiding the very
    // difference this test exists to show) — nPMI is a ratio, not a raw
    // decayed count, so what moves it is `old`'s SHARE of the total mass.
    const repo = buildRepo([
      { files: ["a.ts", "b.ts"] },
      { files: ["a.ts", "b.ts"], daysAgo: 1 },
      { files: ["a.ts", "old.ts"], daysAgo: 720 },
      { files: ["a.ts", "old.ts"], daysAgo: 721 },
      { files: ["n1.ts", "n2.ts"] },
      { files: ["n1.ts", "n2.ts"], daysAgo: 1 },
      { files: ["n1.ts", "n2.ts"], daysAgo: 2 },
    ]);

    const rowFor = (stdout: string, path: string): { npmi: number } | undefined =>
      (JSON.parse(stdout) as Array<{ path: string; npmi: number }>).find((r) => r.path === path);

    const short = runCli(["impact", "a.ts", "--half-life", "10", "--json"], repo, NOW);
    const long = runCli(["impact", "a.ts", "--half-life", "5000", "--json"], repo, NOW);

    const shortOld = rowFor(short.stdout, "old.ts");
    const longOld = rowFor(long.stdout, "old.ts");
    expect(shortOld).toBeDefined();
    expect(longOld).toBeDefined();
    // A short half-life decays the 720-day-old pairing almost to nothing;
    // a long one barely decays it. Same raw data, different weight.
    expect(longOld?.npmi ?? -Infinity).toBeGreaterThan(shortOld?.npmi ?? Infinity);
  });

  it("--since excludes commits older than the given date from the graph", () => {
    // Committed OLDEST first, matching real history: `git log --since`
    // walks the parent chain and its traversal assumes commit dates fall as
    // history is walked back, so a fixture built out of chronological order
    // (a recent commit created before an older one) makes `--since` stop
    // early and drop commits that should have passed the filter.
    const repo = buildRepo([
      { files: ["a.ts", "old.ts"], daysAgo: 61 },
      { files: ["a.ts", "old.ts"], daysAgo: 60 },
      // Noise so `a`'s marginal weight doesn't saturate to ~1 (see the
      // --half-life test above for why that would hide the pair entirely).
      { files: ["n1.ts", "n2.ts"], daysAgo: 2 },
      { files: ["n1.ts", "n2.ts"], daysAgo: 1 },
      { files: ["a.ts", "b.ts"], daysAgo: 1 },
      { files: ["n1.ts", "n2.ts"] },
      { files: ["a.ts", "b.ts"] },
    ]);

    const withoutSince = runCli(["impact", "a.ts", "--json"], repo, NOW);
    const rowsWithout = JSON.parse(withoutSince.stdout) as Array<{ path: string }>;
    expect(rowsWithout.some((r) => r.path === "old.ts")).toBe(true);

    const withSince = runCli(["impact", "a.ts", "--since", "2025-12-01", "--json"], repo, NOW);
    const rowsWith = JSON.parse(withSince.stdout) as Array<{ path: string }>;
    expect(rowsWith.some((r) => r.path === "old.ts")).toBe(false);
    expect(rowsWith.some((r) => r.path === "b.ts")).toBe(true);
  });

  it("--budget changes how much of map.md survives truncation", () => {
    const files = (i: number): string[] => [`mod${i}/a.ts`, `mod${i}/b.ts`];
    const repo = buildRepo(
      Array.from({ length: 8 }, (_, i) => ({ files: files(i) })).flatMap((c) => [c, c]),
    );

    const generous = runCli(["map", "--budget", "5000"], repo, NOW);
    expect(generous.code).toBe(0);
    const generousMap = readFileSync(join(repo, ".octograph", "map.md"), "utf8");
    expect(generousMap).not.toContain("truncated to fit the token budget");

    const tiny = runCli(["map", "--budget", "20"], repo, NOW);
    expect(tiny.code).toBe(0);
    const tinyMap = readFileSync(join(repo, ".octograph", "map.md"), "utf8");
    expect(tinyMap).toContain("truncated to fit the token budget");
  });

  it("--out writes the artifacts under the given directory instead of the default", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);

    const result = runCli(["map", "--out", "custom-graph"], repo, NOW);
    expect(result.code).toBe(0);
    expect(existsSync(join(repo, "custom-graph", "map.md"))).toBe(true);
    expect(existsSync(join(repo, "custom-graph", "clusters.json"))).toBe(true);
    expect(existsSync(join(repo, ".octograph"))).toBe(false);
  });

  it("--out writes where an ABSOLUTE in-repo path names, not nested under the root", () => {
    // The regression: `resolveOut` gated on `insideRepo` (which an absolute
    // in-repo path passes, correctly) and then returned `join(repoRoot,
    // out)`, which CONCATENATES rather than recognising the path as already
    // absolute. `--out <repo>/build/graph` therefore wrote to
    // `<repo>/<repo>/build/graph` — a bogus tree mirroring the whole absolute
    // path inside the repo — and then reported that location as if the user
    // had asked for it. Every previous `--out` test passed a relative value,
    // where `join` and `resolve` agree, so nothing saw it. An absolute path
    // is what a caller that resolved the directory itself passes: the M6 VS
    // Code commands, or any script expanding `$PWD`.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const absolute = join(repo, "build", "graph");

    const result = runCli(["map", "--out", absolute, "--json"], repo, NOW);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).outDir).toBe(join("build", "graph"));
    expect(existsSync(join(absolute, "map.md"))).toBe(true);
    // `join(repo, absolute)` IS the path the old concatenation produced.
    expect(existsSync(join(repo, absolute))).toBe(false);
  });

  it("--out . writes at the repo root and says so, rather than claiming /map.md", () => {
    // `insideRepo` admits the root itself, so `--out .` resolves there — and
    // `relative(repoRoot, repoRoot)` is "", which rendered as "wrote
    // /map.md and /clusters.json": a claim about two files at the filesystem
    // root, not about the two that were actually written.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["map", "--out", "."], repo, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote ./map.md and ./clusters.json");
    expect(existsSync(join(repo, "map.md"))).toBe(true);
  });

  it("--out escaping the repo root falls back to the default via insideRepo", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);

    const result = runCli(["map", "--out", "../../../escaped", "--json"], repo, NOW);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { outDir: string };
    // Falls back to the same default `resolveOut` picks with no `--out` at
    // all (no `.octobots/` in this fixture -> `.octograph`), never a path
    // that climbs out of the repo.
    expect(parsed.outDir).toBe(".octograph");
    expect(existsSync(join(repo, ".octograph", "map.md"))).toBe(true);
    expect(existsSync(join(repo, "..", "..", "..", "escaped"))).toBe(false);
  });
});

describe("runCli — commands", () => {
  it("map writes map.md and clusters.json under the resolved out directory", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["map"], repo, NOW);
    expect(result.code).toBe(0);
    const mapText = readFileSync(join(repo, ".octograph", "map.md"), "utf8");
    expect(mapText).toContain("# Module map");
    const clusters = JSON.parse(readFileSync(join(repo, ".octograph", "clusters.json"), "utf8"));
    expect(clusters.version).toBe(1);
  });

  it("map pins cluster ids onto the previous run via the artifact on disk", () => {
    // Build an initial repo state, then grow it in stages so a second
    // `map` run sees a changed graph.
    const root = buildRepo([
      { files: ["modA/a.ts", "modA/b.ts"] },
      { files: ["modA/a.ts", "modA/b.ts"], daysAgo: 1 },
      { files: ["modB/c.ts", "modB/d.ts"] },
      { files: ["modB/c.ts", "modB/d.ts"], daysAgo: 1 },
    ]);

    const first = runCli(["map", "--json"], root, NOW);
    expect(first.code).toBe(0);
    const firstClusters = JSON.parse(
      readFileSync(join(root, ".octograph", "clusters.json"), "utf8"),
    ) as { clusters: Record<string, string[]> };
    const idForA = Object.entries(firstClusters.clusters).find(([, members]) =>
      members.includes("modA/a.ts"),
    )?.[0];
    expect(idForA).toBeDefined();

    // Touch only modB.
    appendCommits(root, [{ files: ["modB/c.ts", "modB/d.ts"] }]);
    const second = runCli(["map", "--json"], root, NOW);
    expect(second.code).toBe(0);
    const secondClusters = JSON.parse(
      readFileSync(join(root, ".octograph", "clusters.json"), "utf8"),
    ) as { clusters: Record<string, string[]> };
    const idForA2 = Object.entries(secondClusters.clusters).find(([, members]) =>
      members.includes("modA/a.ts"),
    )?.[0];
    expect(idForA2).toBe(idForA);
  });

  /**
   * The whole-mission integration defect: three task PRs each held up their own
   * half of the contract and the seam between them did not.
   *
   * T3.3's `readArtifact` validates a `clusters.json` document's shape and
   * documents that "anything that is not a v1 StoredGraph degrades to null" —
   * but it validated only the VALUES, never the keys, while `StoredGraph`
   * types them `Record<number, string[]>` and JSON can hold no such thing.
   * T3.5's `clustersToMap` then does `Number(id)`, and T3.4's `remapClusters`
   * mints fresh ids from `Math.max(...oldIds) + 1`. One key that does not parse
   * — a merge-conflict resolution, a hand edit, a future writer — makes that
   * `NaN`, so every module in the run is assigned the id `NaN` and
   * `analysisToClusters` writes ALL of them back under the single object key
   * "NaN". Reproduced against this exact fixture: three modules in, one
   * `"NaN"` entry out, exit code 0, `clusterIds` reporting `{kept: 3, fresh: 0}`
   * because `Map.has(NaN)` is true. And because the run re-reads its own
   * artifact next time, it never recovers on its own.
   *
   * Asserted through the real CLI and off the real file, not against
   * `readArtifact` in isolation: the unit-level guard is in artifact.test.ts,
   * and it was the *composition* that shipped broken.
   */
  it("survives a clusters.json whose cluster id is not a number, rather than collapsing every module onto one", () => {
    const repo = buildRepo([
      { files: ["modA/a.ts", "modA/b.ts"] },
      { files: ["modA/a.ts", "modA/b.ts"], daysAgo: 1 },
      { files: ["modB/c.ts", "modB/d.ts"] },
      { files: ["modB/c.ts", "modB/d.ts"], daysAgo: 1 },
      { files: ["modC/e.ts", "modC/f.ts"] },
      { files: ["modC/e.ts", "modC/f.ts"], daysAgo: 1 },
    ]);
    const clustersPath = join(repo, ".octograph", "clusters.json");

    const first = runCli(["map", "--json"], repo, NOW);
    expect(first.code).toBe(0);
    const moduleCount = (JSON.parse(first.stdout) as { modules: number }).modules;
    expect(moduleCount).toBeGreaterThan(1);

    // Corrupt exactly one thing: a cluster id that is not a number.
    const stored = JSON.parse(readFileSync(clustersPath, "utf8")) as {
      version: number;
      clusters: Record<string, string[]>;
      config: unknown;
    };
    const firstMembers = Object.values(stored.clusters)[0] ?? [];
    writeFileSync(
      clustersPath,
      JSON.stringify({ ...stored, clusters: { "cluster-a": firstMembers } }, null, 2) + "\n",
    );

    const second = runCli(["map", "--json"], repo, NOW);
    expect(second.code).toBe(0);
    const rewritten = JSON.parse(readFileSync(clustersPath, "utf8")) as {
      clusters: Record<string, string[]>;
    };

    // One entry per module analyse() produced — not one "NaN" entry for all of
    // them, and no "NaN" key anywhere.
    expect(Object.keys(rewritten.clusters)).toHaveLength(moduleCount);
    expect(Object.keys(rewritten.clusters)).not.toContain("NaN");
    for (const id of Object.keys(rewritten.clusters)) expect(id).toMatch(/^(0|[1-9][0-9]*)$/);

    // And it says so honestly: an unreadable previous artifact is NO previous
    // artifact, so every id is fresh. The bug claimed all of them were kept.
    expect((JSON.parse(second.stdout) as { clusterIds: { kept: number; fresh: number } }).clusterIds)
      .toEqual({ kept: 0, fresh: moduleCount });

    // Self-healing: the artifact it just wrote is readable again, so a third
    // run pins onto it rather than re-minting forever.
    const third = runCli(["map", "--json"], repo, NOW);
    expect(
      (JSON.parse(third.stdout) as { clusterIds: { kept: number; fresh: number } }).clusterIds,
    ).toEqual({ kept: moduleCount, fresh: 0 });
  });

  it("impact ranks coupled files by nPMI and returns nothing for an unknown path", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["impact", "a.ts"], repo, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("b.ts");

    const missing = runCli(["impact", "nope.ts", "--json"], repo, NOW);
    expect(JSON.parse(missing.stdout)).toEqual([]);
  });

  it("drift reports only coupling the declared structure does not already explain", () => {
    const repo = buildRepo([
      { files: ["modA/a.ts", "modB/b.ts"] },
      { files: ["modA/a.ts", "modB/b.ts"], daysAgo: 1 },
    ]);
    const result = runCli(["drift", "--json"], repo, NOW);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{ a: string; b: string }>;
    expect(rows.some((r) => (r.a === "modA/a.ts" && r.b === "modB/b.ts"))).toBe(true);
  });

  it("doctor exits non-zero and names a fix outside a git repository", () => {
    const noGit = mkdtempClean("octograph-nogit-");
    const result = runCli(["doctor"], noGit, NOW);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("blocked");
  });
});

describe("runCli — map records --since provenance and warns on a mismatched history window", () => {
  it("records the --since window on clusters.json", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["map", "--since", "2026-01-01"], repo, NOW);
    expect(result.code).toBe(0);
    const stored = JSON.parse(readFileSync(join(repo, ".octograph", "clusters.json"), "utf8")) as {
      since: unknown;
    };
    expect(stored.since).toBe("2026-01-01");
  });

  it("records since: null for a full-history run (no --since given)", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["map"], repo, NOW);
    expect(result.code).toBe(0);
    const stored = JSON.parse(readFileSync(join(repo, ".octograph", "clusters.json"), "utf8")) as {
      since: unknown;
    };
    expect(stored.since).toBeNull();
  });

  it("stays silent across two runs with the same --since", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    runCli(["map", "--since", "2026-01-01"], repo, NOW);
    const second = runCli(["map", "--since", "2026-01-01"], repo, NOW);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe("");
  });

  it("stays silent across two full-history runs (no --since either time)", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    runCli(["map"], repo, NOW);
    const second = runCli(["map"], repo, NOW);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe("");
  });

  /**
   * The actual harm the bug names: `remapClusters` reads `clusters.json` back
   * to pin cluster ids, and that comparison is meaningless once the two runs
   * harvested different history windows. This is a WARNING, not a failure —
   * consistent with this package's degrade-don't-throw convention elsewhere
   * (`resolveOut`, `loadConfig`) — so exit code stays 0 and the artifact is
   * still written correctly, but stderr says so.
   */
  it("warns on stderr, but stays exit 0 and still writes clusters.json, when --since differs from the previous run", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    runCli(["map", "--since", "2026-01-01"], repo, NOW);
    const second = runCli(["map", "--since", "2026-02-01"], repo, NOW);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("2026-01-01");
    expect(second.stderr).toContain("2026-02-01");
    expect(second.stderr).toContain("not meaningful");
    const stored = JSON.parse(readFileSync(join(repo, ".octograph", "clusters.json"), "utf8")) as {
      since: unknown;
    };
    expect(stored.since).toBe("2026-02-01");
  });

  /**
   * `previous.since === undefined` — a legacy artifact predating this fix —
   * says NOTHING, not "full history": there is no reliable provenance to
   * compare, and claiming a mismatch (or a match) that cannot actually be
   * verified is exactly the false-claim class this bug is about.
   */
  it("says nothing when the previous clusters.json has no since key at all, regardless of --since", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const first = runCli(["map"], repo, NOW);
    expect(first.code).toBe(0);
    const clustersPath = join(repo, ".octograph", "clusters.json");
    const stored = JSON.parse(readFileSync(clustersPath, "utf8")) as Record<string, unknown>;
    delete stored.since;
    writeFileSync(clustersPath, JSON.stringify(stored, null, 2) + "\n");

    const second = runCli(["map", "--since", "2026-01-01"], repo, NOW);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe("");
  });
});
