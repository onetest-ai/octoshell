import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCampaign, createMission, createTask } from "@octoshell/board";
import { parseArgs, runCli } from "../src/cli.js";
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

  it("--out escaping the repo root is REJECTED, and writes nothing anywhere", () => {
    // This test used to assert that an escaping `--out` fell back to the
    // default. Its real intent was the security property — that
    // `../../../escaped` never gets written — and that is unchanged and still
    // asserted below.
    //
    // What changed (2026-08-12) is the silence. A flag the parser accepts and
    // then discards is the defect `--half-life-days` was rewritten to make
    // impossible, and here it had teeth: running octograph against ANOTHER
    // repository with `--out` pointed at a scratch directory wrote `map.md`
    // and `clusters.json` into that repository's tracked `.octobots/`
    // instead, exit 0, no warning. Falling back to a default the caller did
    // not name is the harm; refusing is the fix.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);

    const result = runCli(["map", "--out", "../../../escaped", "--json"], repo, NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out must name a path inside the repository");

    // The original security assertion, kept verbatim in spirit: nothing
    // climbs out of the repo.
    expect(existsSync(join(repo, "..", "..", "..", "escaped"))).toBe(false);
    // And now also: no quiet write to the default the caller never asked for.
    expect(existsSync(join(repo, ".octograph"))).toBe(false);
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

describe("runCli — own", () => {
  /** A repo that is both a git repository and an Octobots board — `own`
   *  needs both. Mirrors `own.test.ts`'s and `attribution.test.ts`'s
   *  fixtures. */
  function repoWithBoardAndGit(): { root: string; octobotsDir: string; git: (args: string[]) => string } {
    const root = mkdtempClean("octograph-cli-own-");
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    const octobotsDir = join(root, ".octobots");
    mkdirSync(octobotsDir, { recursive: true });
    return { root, octobotsDir, git };
  }

  function commit(root: string, git: (args: string[]) => string, files: Record<string, string>): string {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "test commit"]);
    return git(["rev-parse", "HEAD"]).trim();
  }

  /** Writes `.octobots/tokenomics/worklog.jsonl` in the shape
   *  `hooks/work-log.mjs` actually writes — snake_case keys. */
  function writeWorklog(root: string, lines: Array<Record<string, unknown>>): void {
    const dir = join(root, ".octobots", "tokenomics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worklog.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("exits 2 when own is given more than one positional argument", () => {
    // The regression this guards: `runCli` today accepts a positional only
    // for `impact` and rejects one for every other command — `own [<path>]`
    // needs its OWN explicit handling, not silent acceptance of extras.
    const result = runCli(["own", "a.ts", "b.ts"], tinyRepo(), NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("own");
  });

  it("accepts own with zero positional arguments", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "a.ts": "content\n", "b.ts": "content\n" });
    createCampaign(octobotsDir, { name: "Q3" });
    const result = runCli(["own"], root, NOW);
    expect(result.code).toBe(0);
  });

  it("own on a repo with no board exits non-zero naming the missing board, and no other command's behaviour changes", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);

    const ownResult = runCli(["own"], repo, NOW);
    expect(ownResult.code).not.toBe(0);
    expect(ownResult.stderr).toContain("board");

    const ownWithPath = runCli(["own", "a.ts"], repo, NOW);
    expect(ownWithPath.code).not.toBe(0);
    expect(ownWithPath.stderr).toContain("board");

    // Every other command still produces its normal, unaffected output on
    // the SAME boardless repo.
    expect(runCli(["map"], repo, NOW).code).toBe(0);
    expect(runCli(["impact", "a.ts"], repo, NOW).code).toBe(0);
    expect(runCli(["drift"], repo, NOW).code).toBe(0);
    expect(runCli(["doctor"], repo, NOW).stdout).toContain("no board");
  });

  it("own <path> names the owning mission and criterion, labelled provenance, through the CLI", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the auth token is validated",
    });
    writeWorklog(root, [
      { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: sha, at: "2026-08-10T00:00:00.000Z" },
    ]);

    const result = runCli(["own", "src/auth.ts"], root, NOW);
    expect(result.code).toBe(0);
    // Named by the words a person gave the mission/task, not by their
    // folder-derived ids — the bug this test now pins the fix for.
    expect(result.stdout).toContain("M1 - Auth");
    expect(result.stdout).toContain("T1.1 - JWT");
    expect(result.stdout).not.toContain(mission.id);
    expect(result.stdout).toContain("the auth token is validated");
    // The ownership clause carries `provenance`; the criterion clause carries
    // its OWN, different label. A single mode on the row read as a claim that
    // the criterion came off the merge too — it cannot (see own.ts).
    expect(result.stdout).toContain(`(provenance)`);
    expect(result.stdout).toContain("criterion (predicted): the auth token is validated");
  });

  /**
   * The bug this fixes, pinned directly: `own`'s stated reader is a person
   * asking why code exists, and a folder id (`folder:campaigns/.../missions/
   * <slug>`) answers a different question than a name does. The stable id
   * stays reachable — for a MACHINE consumer, through `own --json`, which is
   * a contract (see own.ts's `OwnAnswer.task`/`.mission`) — but the rendered
   * text a human reads must never fall back to it.
   */
  it("own's human-readable output names the mission and task, never their folder ids", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the auth token is validated",
    });
    writeWorklog(root, [
      { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: sha, at: "2026-08-10T00:00:00.000Z" },
    ]);

    const text = runCli(["own", "src/auth.ts"], root, NOW);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("M1 - Auth");
    expect(text.stdout).toContain("T1.1 - JWT");
    expect(text.stdout).not.toContain("folder:");

    // The same query with `--json`: the stable id is still the join key a
    // machine consumer gets, alongside the human-readable name.
    const json = runCli(["own", "src/auth.ts", "--json"], root, NOW);
    expect(json.code).toBe(0);
    const answers = JSON.parse(json.stdout) as Array<{
      mission: string;
      missionName: string;
      task: string;
      taskName: string;
    }>;
    expect(answers).toHaveLength(1);
    expect(answers[0]?.mission).toBe(mission.id);
    expect(answers[0]?.missionName).toBe("M1 - Auth");
    expect(answers[0]?.task).toBe(task.id);
    expect(answers[0]?.taskName).toBe("T1.1 - JWT");
  });

  /**
   * M7 shipped a defect where a newline inside a filename injected a phantom
   * line into rendered `map.md`. `own` renders a second, softer target on the
   * same line-oriented surface: **acceptance-criterion text**, which is
   * free-form prose a person types into `task.yaml` rather than a path git
   * had to accept. `parseCriteriaString` splits on newlines, so a criterion
   * cannot carry one — but nothing stops it carrying a TAB, and `own`'s rows
   * are TAB-separated, so an unescaped one silently shifts the criterion into
   * the ownership column of a parser reading this output. A control character
   * does the same to a terminal.
   *
   * `formatOwnAnswer` escapes through `render.ts`'s `oneLine` for exactly
   * this, but nothing pinned it on this surface — and "the code currently
   * calls the right helper" is not the same claim as "a criterion cannot
   * forge a field". Asserted on the shape of the whole rendered block: one
   * line and the fixed number of tab-separated fields per answer, whatever
   * the criterion text contains.
   */
  it("cannot let criterion text forge a row or a field in own's rendered output", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      // A tab (own's own field separator) and a bell, inside authored prose.
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the auth token\tis\u0007validated",
    });
    writeWorklog(root, [
      { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: sha, at: "2026-08-10T00:00:00.000Z" },
    ]);

    const result = runCli(["own", "src/auth.ts"], root, NOW);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1); // one answer, one row
    expect(lines[0]?.split("\t")).toHaveLength(3); // path, ownership, criterion
    expect(result.stdout).toContain("token\\x09is\\x07validated");
    expect(result.stdout).not.toContain("token\tis");
  });

  /**
   * The rendered half of `own.test.ts`'s "names no criterion…" regression: a
   * file whose owning task's criteria share nothing with its path must not
   * print a criterion under the row's `provenance` badge. It used to print
   * the alphabetically-first criterion there.
   */
  it("own prints no criterion, rather than one under the provenance label, when nothing supports one", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/louvain.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Clustering" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.5 - Louvain",
      acceptanceCriteria: "- [ ] autoResolution returns 1.0 below 2 nodes",
    });
    writeWorklog(root, [
      { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: sha, at: "2026-08-10T00:00:00.000Z" },
    ]);

    const result = runCli(["own", "src/louvain.ts"], root, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(provenance)");
    expect(result.stdout).not.toContain("autoResolution");
    expect(result.stdout).toContain("criterion: none");
  });

  /**
   * M7 shipped a defect where a newline in a filename injected a phantom line
   * into rendered markdown; `own`'s stdout is line-oriented for the same
   * reason `map.md` is, and its rows come from the same repo-controlled path
   * strings. One answer must stay one line.
   */
  it("own renders a path containing a newline as one line, not two", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/a\nb.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the auth token is validated",
    });
    writeWorklog(root, [
      { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: sha, at: "2026-08-10T00:00:00.000Z" },
    ]);

    const result = runCli(["own"], root, NOW);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("src/a\\x0ab.ts");
  });

  it("own <path> against a worklog holding only mission-level entries still answers, labelled predicted", () => {
    const { root, octobotsDir } = repoWithBoardAndGit();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the session token is validated on every login attempt",
    });
    writeWorklog(root, [{ session_id: "s1", mission: mission.id, at: "2026-08-10T00:00:00.000Z" }]);

    const repo = buildRepo([
      { files: ["src/auth/session.ts", "src/auth/login.ts"] },
      { files: ["src/auth/session.ts", "src/auth/login.ts"], daysAgo: 1 },
      { files: ["src/billing/invoice.ts", "src/billing/ledger.ts"] },
      { files: ["src/billing/invoice.ts", "src/billing/ledger.ts"], daysAgo: 1 },
    ]);
    // Reuse the git history from `repo`, but the board/worklog from `root` —
    // `own` reads the board and worklog off the SAME repo it harvests, so
    // graft the board directory across rather than maintaining two fixtures.
    execFileSync("cp", ["-R", join(root, ".octobots"), join(repo, ".octobots")]);

    const result = runCli(["own", "src/auth/session.ts"], repo, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("M1 - Auth");
    expect(result.stdout).toContain("predicted");
    expect(result.stdout).not.toContain("provenance");
  });

  /**
   * The regression this pins: `own` accepted `--since` and silently used it
   * to narrow the co-change corpus every PREDICTED answer is scored against,
   * with nothing on stderr explaining that the same query can answer
   * differently under a different window. Verified pre-fix: `own <path>
   * --since <date>` printed nothing to stderr at all.
   */
  it("own --since narrows the predicted corpus and says so on stderr; plain own stays silent", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "src/auth/session.ts": "content\n", "src/auth/login.ts": "content\n" });
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the session token is validated",
    });

    const withSince = runCli(["own", "src/auth/session.ts", "--since", "2026-08-10"], root, NOW);
    expect(withSince.code).toBe(0);
    expect(withSince.stderr).toContain("--since 2026-08-10");
    expect(withSince.stderr).toContain("predicted");

    const withoutSince = runCli(["own", "src/auth/session.ts"], root, NOW);
    expect(withoutSince.stderr).toBe("");
  });
});

describe("runCli — conflicts", () => {
  /** A campaign spanning two missions, each with its own task(s), on a repo
   *  whose git history co-changes the two files those tasks' criteria
   *  predict — enough to exercise `shared` (two tasks in the SAME mission
   *  naming the same file), `coupled` (a cross-mission pair whose files
   *  differ but historically co-change), and every one of `conflicts`'
   *  positional shapes (mission id, campaign id, explicit task ids). */
  function conflictFixture() {
    const repo = buildRepo([
      { files: ["src/auth/session.ts", "src/billing/invoice.ts"] },
      { files: ["src/auth/session.ts", "src/billing/invoice.ts"], daysAgo: 1 },
    ]);
    const octobotsDir = join(repo, ".octobots");
    mkdirSync(octobotsDir, { recursive: true });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const missionA = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    // Both tasks in mission A predict the SAME file — a `shared` conflict.
    const taskA1 = createTask(octobotsDir, missionA.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the auth session token is validated",
    });
    const taskA2 = createTask(octobotsDir, missionA.id, {
      name: "T1.2 - Refresh",
      acceptanceCriteria: "- [ ] the auth session token is validated",
    });
    const missionB = createMission(octobotsDir, campaign.id, { title: "M2 - Billing" });
    // Predicts a DIFFERENT file that historically co-changes with session.ts
    // — a `coupled` conflict, visible only once the campaign spans mission B.
    const taskB1 = createTask(octobotsDir, missionB.id, {
      name: "T2.1 - Invoicing",
      acceptanceCriteria: "- [ ] the billing invoice totals are correct",
    });

    return { repo, campaign, missionA, missionB, taskA1, taskA2, taskB1 };
  }

  function writeWorklog(root: string, lines: Array<Record<string, unknown>>): void {
    const dir = join(root, ".octobots", "tokenomics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worklog.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("exits 2 when conflicts is given no id at all", () => {
    const result = runCli(["conflicts"], tinyRepo(), NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("conflicts");
  });

  it("conflicts on a repo with no board exits non-zero naming the missing board", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"], daysAgo: 1 }]);
    const result = runCli(["conflicts", "anything"], repo, NOW);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("board");
  });

  it("exits with a usage error naming an id that matches no campaign, mission, or task", () => {
    const { repo } = conflictFixture();
    const result = runCli(["conflicts", "does-not-exist"], repo, NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does-not-exist");
  });

  it("a mission id reports the shared-file conflict between that mission's own tasks", () => {
    const { repo, missionA, taskA1, taskA2 } = conflictFixture();
    const result = runCli(["conflicts", missionA.id, "--json"], repo, NOW);
    expect(result.code).toBe(0);
    const { pairs } = JSON.parse(result.stdout) as {
      pairs: Array<{ a: string; b: string; shared: string[] }>;
    };
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.a, pairs[0]?.b].sort()).toEqual([taskA1.id, taskA2.id].sort());
    expect(pairs[0]?.shared).toEqual(["src/auth/session.ts"]);
  });

  it("a campaign id spanning more than one mission also surfaces the cross-mission coupled conflict", () => {
    const { repo, campaign, taskA1, taskA2, taskB1 } = conflictFixture();
    const result = runCli(["conflicts", campaign.id, "--json"], repo, NOW);
    expect(result.code).toBe(0);
    const { pairs } = JSON.parse(result.stdout) as {
      pairs: Array<{ a: string; b: string; coupled: number }>;
    };
    const pairKeys = pairs.map((p) => [p.a, p.b].sort().join("|")).sort();
    expect(pairKeys).toEqual(
      [
        [taskA1.id, taskA2.id].sort().join("|"),
        [taskA1.id, taskB1.id].sort().join("|"),
        [taskA2.id, taskB1.id].sort().join("|"),
      ].sort(),
    );
  });

  it("an explicit task list reports only the conflict between exactly those tasks", () => {
    const { repo, taskA1, taskB1 } = conflictFixture();
    const result = runCli(["conflicts", taskA1.id, taskB1.id, "--json"], repo, NOW);
    expect(result.code).toBe(0);
    const { pairs } = JSON.parse(result.stdout) as {
      pairs: Array<{ a: string; b: string; coupled: number }>;
    };
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.a, pairs[0]?.b].sort()).toEqual([taskA1.id, taskB1.id].sort());
    expect(pairs[0]?.coupled).toBeGreaterThan(0);
  });

  it("names every missing id when an explicit task list has more than one bad entry", () => {
    const { repo, taskA1 } = conflictFixture();
    const result = runCli(["conflicts", taskA1.id, "nope-1", "nope-2"], repo, NOW);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nope-1");
    expect(result.stderr).toContain("nope-2");
  });

  /**
   * Mission criterion: "every answer from `own` or `conflicts` names which
   * mode produced it". Asserted on the RENDERED output and on the JSON, not
   * in memory — an unlabelled row printed beside `own`'s labelled ones is
   * where a reader would actually be misled.
   */
  it("labels every rendered and JSON conflict row with the mode that produced it", () => {
    const { repo, missionA } = conflictFixture();

    const text = runCli(["conflicts", missionA.id], repo, NOW);
    expect(text.code).toBe(0);
    for (const line of text.stdout.trimEnd().split("\n")) {
      expect(line).toContain("(predicted)");
    }

    const json = runCli(["conflicts", missionA.id, "--json"], repo, NOW);
    const { pairs } = JSON.parse(json.stdout) as { pairs: Array<{ mode: string }> };
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(p.mode).toBe("predicted");
  });

  /**
   * The rendered form of the claim `conflicts` makes when it finds nothing.
   *
   * `predictFiles` answers for a minority of real tasks (see `lexical.ts`'s
   * calibration: 3 of 8 on this repo's own labelled dataset; 1 of 6 on this
   * repo's M4 mission), and a task with no predicted surface takes part in no
   * pair. So a mission the predictor had nothing to say about printed exactly
   * what a genuinely clean decomposition prints — `(no conflicts found)`,
   * with no way for a reader to tell a verdict from an absence of evidence.
   * That is a claim outrunning what was computed, in the one command whose
   * whole product is that verdict.
   */
  it("states how many tasks it actually predicted a surface for, so an empty answer is not read as a clean one", () => {
    const { repo, campaign } = conflictFixture();
    const octobotsDir = join(repo, ".octobots");
    // Two more tasks whose criteria are pure boilerplate: no distinctive
    // token, so `predictFiles` returns nothing for either and neither can
    // appear in any pair.
    const mission = createMission(octobotsDir, campaign.id, { title: "M3 - Boilerplate" });
    const boilerplate = ["T3.1 - One", "T3.2 - Two"].map((name) =>
      createTask(octobotsDir, mission.id, {
        name,
        acceptanceCriteria: "- [ ] the code is well tested",
      }),
    );

    const text = runCli(["conflicts", mission.id], repo, NOW);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("(no conflicts found)");
    // The distinguishing fact: nothing was predicted for either task, so the
    // empty result says nothing whatever about this decomposition — and the
    // tasks it says nothing about are named, not merely counted.
    expect(text.stdout).toContain("0 of 2");
    for (const t of boilerplate) expect(text.stdout).toContain(t.id);

    const json = runCli(["conflicts", mission.id, "--json"], repo, NOW);
    const report = JSON.parse(json.stdout) as { pairs: unknown[]; covered: string[]; uncovered: string[] };
    expect(report.pairs).toEqual([]);
    expect(report.covered).toEqual([]);
    expect(report.uncovered).toHaveLength(2);
  });

  /**
   * `octograph.yaml`'s lexical keys must reach `predictFiles`. The
   * regression: `own` and `conflicts` both called it with no options, so
   * `lexicalConfidenceFloor` / `lexicalRunnerUpMargin` were parsed,
   * range-checked, documented — and changed no answer this CLI produced,
   * the same silent-ignore defect `parseArgs` exists to make impossible for
   * flags.
   */
  it("applies octograph.yaml's lexical floor to conflicts rather than ignoring it", () => {
    // `session.ts` recovers 2 of the query's 3 scoring tokens (`token` is the
    // other file's, `validated` is nobody's) — 2/3, over the default floor
    // and under the configured one.
    const repo = buildRepo([
      { files: ["src/auth/session.ts", "src/token/store.ts"] },
      { files: ["src/auth/session.ts", "src/token/store.ts"], daysAgo: 1 },
    ]);
    const octobotsDir = join(repo, ".octobots");
    mkdirSync(octobotsDir, { recursive: true });
    const campaign = createCampaign(octobotsDir, { name: "Q4" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    for (const name of ["T1.1 - JWT", "T1.2 - Refresh"]) {
      createTask(octobotsDir, mission.id, {
        name,
        acceptanceCriteria: "- [ ] the auth session token is validated",
      });
    }

    const byDefault = runCli(["conflicts", mission.id, "--json"], repo, NOW);
    expect((JSON.parse(byDefault.stdout) as { pairs: unknown[] }).pairs).toHaveLength(1);

    writeFileSync(join(repo, "octograph.yaml"), "lexicalConfidenceFloor: 0.7\n");
    const strict = runCli(["conflicts", mission.id, "--json"], repo, NOW);
    expect(strict.code).toBe(0);
    // Raising the floor stops the predictor answering at all, which is a
    // DIFFERENT outcome from a clean decomposition — and the report says so
    // rather than reporting an empty list that reads as "no conflict".
    const stricter = JSON.parse(strict.stdout) as { pairs: unknown[]; covered: string[] };
    expect(stricter.pairs).toEqual([]);
    expect(stricter.covered).toEqual([]);
  });

  /**
   * `conflicts` runs in `predicted` mode permanently and never reads the
   * worklog (see conflicts.ts's doc comment) — its answer for the SAME task
   * set must be byte-identical whether the worklog holds nothing at all, a
   * mission-level-only entry (the day-one state `own`'s own test covers),
   * or a fully task-attributed one with a resolvable `merged_sha`. `own`'s
   * mode changes with the evidence; `conflicts`' output must not change at
   * all.
   */
  it("answers identically regardless of the worklog's contents — mission-only, fully-attributed, or absent", () => {
    const { repo, campaign, missionA, taskA1 } = conflictFixture();
    const noWorklog = runCli(["conflicts", campaign.id, "--json"], repo, NOW);

    writeWorklog(repo, [
      { session_id: "s1", mission: missionA.id, at: "2026-08-10T00:00:00.000Z" },
    ]);
    const missionOnly = runCli(["conflicts", campaign.id, "--json"], repo, NOW);

    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    writeWorklog(repo, [
      {
        session_id: "s1",
        task: taskA1.id,
        branch: "feat/x-t1",
        merged_sha: sha,
        at: "2026-08-10T00:00:00.000Z",
      },
    ]);
    const fullyAttributed = runCli(["conflicts", campaign.id, "--json"], repo, NOW);

    expect(missionOnly.stdout).toBe(noWorklog.stdout);
    expect(fullyAttributed.stdout).toBe(noWorklog.stdout);
  });

  /**
   * The same regression as `own`'s: `conflicts` accepted `--since` and
   * silently used it to narrow the co-change corpus its ENTIRE answer is
   * scored against (see conflicts.ts's doc comment — every row is
   * `predicted`), with nothing on stderr explaining why the same task set
   * can answer differently under a different window.
   */
  it("conflicts --since narrows the predicted corpus and says so on stderr; plain conflicts stays silent", () => {
    const { repo, missionA } = conflictFixture();

    const withSince = runCli(["conflicts", missionA.id, "--since", "2026-08-10"], repo, NOW);
    expect(withSince.code).toBe(0);
    expect(withSince.stderr).toContain("--since 2026-08-10");
    expect(withSince.stderr).toContain("predicted");

    const withoutSince = runCli(["conflicts", missionA.id], repo, NOW);
    expect(withoutSince.stderr).toBe("");
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

describe("--out containment", () => {
  /**
   * `resolveOut` only honours `config.out` when `insideRepo` accepts it, and
   * an escaping path falls through to the default. For `octograph.yaml`'s
   * `out:` that degradation is deliberate — a config file should not fail a
   * build over one bad key. For a FLAG it is the defect `--half-life-days`
   * was rewritten to make impossible: typed for this run, accepted by the
   * parser, then silently ignored.
   *
   * Observed harm: running octograph against another repository with `--out`
   * pointed at a scratch directory wrote `map.md` and `clusters.json` into
   * THAT repository instead, where `.octobots/` was tracked rather than
   * ignored. No warning, exit 0.
   */
  it("rejects an --out that resolves outside the repository", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const outside = join(mkdtempClean("octograph-outside-"), "artifacts");
    const res = runCli(["map", "--out", outside], repo, NOW);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--out must name a path inside the repository");
    // The value is quoted back, because "outside it" is unactionable without
    // saying which path the tool actually resolved.
    expect(res.stderr).toContain(outside);
  });

  it("does not fall back to the default location when --out is rejected", () => {
    // The whole harm was the silent WRITE, not the ignored flag: a rejected
    // --out must produce nothing at all, or the caller gets artifacts in a
    // directory they never named.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const outside = join(mkdtempClean("octograph-outside-"), "artifacts");
    runCli(["map", "--out", outside], repo, NOW);

    expect(existsSync(join(repo, ".octograph"))).toBe(false);
    expect(existsSync(join(repo, ".octobots", "graph"))).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  it("still honours an --out inside the repository", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const res = runCli(["map", "--out", "artifacts/graph"], repo, NOW);

    expect(res.code).toBe(0);
    expect(existsSync(join(repo, "artifacts", "graph", "map.md"))).toBe(true);
  });

  it("uses the same exit code as any other usage error", () => {
    // A caller scripting octograph branches on the code, not the prose.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const outside = join(mkdtempClean("octograph-outside-"), "artifacts");
    expect(runCli(["map", "--out", outside], repo, NOW).code)
      .toBe(runCli(["map", "--nonsense-flag"], repo, NOW).code);
  });
});

describe("runCli — impact --diff", () => {
  /** Writes `body` at `rel` inside `root`, creating parent directories. */
  function write(root: string, rel: string, body: string): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  /**
   * `main` two commits deep — a.ts/b.ts co-change both times, support 2,
   * clearing the default `minSupport` floor — with a `feature` branch one
   * commit ahead that edits only a.ts. Gives `diffImpact` a real answer:
   * b.ts is the historically-coupled file a.ts's change should have pulled
   * in, without touching it directly.
   */
  function repoWithCoupledBranch(): string {
    const repo = buildRepo([
      { files: ["a.ts", "b.ts"], daysAgo: 2 },
      { files: ["a.ts", "b.ts"], daysAgo: 1 },
    ]);
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: repo });
    appendCommits(repo, [{ files: ["a.ts"] }]);
    return repo;
  }

  describe("parsing", () => {
    it("rejects --diff together with a positional path", () => {
      const result = runCli(["impact", "--diff", "a.ts"], tinyRepo(), NOW);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--diff and a <path> are mutually exclusive");
    });

    it("rejects a scope flag given without --diff, naming the flag rather than silently implying it", () => {
      const result = runCli(["impact", "--staged"], tinyRepo(), NOW);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--staged requires --diff");
    });

    it("rejects two scope flags at once", () => {
      const result = runCli(["impact", "--diff", "--staged", "--worktree"], tinyRepo(), NOW);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("only one of --staged, --worktree");
    });

    it("requires a value for --base", () => {
      expect(parseArgs(["impact", "--diff", "--base"])).toEqual({
        ok: false,
        error: "--base requires a value",
      });
    });

    it("--base takes a ref, and an unrelated flag typo is still named as unrecognised", () => {
      // `--sInce` is deliberately NOT `--since` (a real flag, case-sensitive
      // match only) — this pins that a scope-shaped or lookalike flag never
      // gets a special "did you mean a scope?" pass; it is just unrecognised,
      // the same as everywhere else in this parser.
      const result = runCli(["impact", "--diff", "--sInce"], tinyRepo(), NOW);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unrecognised flag: --sInce");
    });
  });

  it("changed: 0 when the branch matches its base, and reports no impact rather than erroring", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const result = runCli(["impact", "--diff"], repo, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("changed: 0 file(s)");
    expect(result.stdout).toContain("nothing changed against the base");
  });

  it("reports a historically coupled file as source impact, citing the changed file that pulled it in", () => {
    const repo = repoWithCoupledBranch();
    const result = runCli(["impact", "--diff", "--json"], repo, NOW);
    expect(result.code).toBe(0);
    const answer = JSON.parse(result.stdout) as {
      changed: string[];
      source: Array<{ path: string; predictedBy: string[] }>;
      tests: unknown[];
    };
    expect(answer.changed).toEqual(["a.ts"]);
    expect(answer.source.some((r) => r.path === "b.ts" && r.predictedBy.includes("a.ts"))).toBe(true);
  });

  it("renders the human text with the changed count, the section heading, and npmi/support/via", () => {
    const repo = repoWithCoupledBranch();
    const result = runCli(["impact", "--diff"], repo, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("changed: 1 file(s)");
    expect(result.stdout).toContain("you may also need to change:");
    expect(result.stdout).toMatch(/b\.ts\s+npmi=\d\.\d{3}\s+support=\d+\s+via a\.ts/);
  });

  it("--staged and --worktree scope to only uncommitted work, not the whole branch", () => {
    // repoWithCoupledBranch's feature commit is already committed, so neither
    // the index nor the worktree holds anything relative to HEAD — a
    // different answer from the branch-scope test above, which is the point:
    // an implementation that ignored the scope flag entirely would report
    // `changed: 1` here too.
    const repo = repoWithCoupledBranch();

    const staged = runCli(["impact", "--diff", "--staged"], repo, NOW);
    expect(staged.code).toBe(0);
    expect(staged.stdout).toContain("changed: 0 file(s)");

    const worktree = runCli(["impact", "--diff", "--worktree"], repo, NOW);
    expect(worktree.code).toBe(0);
    expect(worktree.stdout).toContain("changed: 0 file(s)");
  });

  it("--base overrides which ref the branch is measured against", () => {
    const root = mkdtempClean("cli-diff-base-");
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    write(root, "a.ts", "1\n");
    write(root, "b.ts", "1\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    const firstSha = git(["rev-parse", "HEAD"]).trim();
    write(root, "a.ts", "2\n");
    write(root, "b.ts", "2\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "c2"]);
    git(["branch", "other-base", firstSha]);
    git(["checkout", "-qb", "feature"]);
    write(root, "a.ts", "3\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "c3"]);

    // Default base (config.diffBase = "main"): only a.ts changed since c2.
    const defaultBase = runCli(["impact", "--diff", "--json"], root, NOW);
    expect((JSON.parse(defaultBase.stdout) as { changed: string[] }).changed).toEqual(["a.ts"]);

    // --base other-base measures back to c1, so b.ts's c2 edit is in scope too.
    const overridden = runCli(["impact", "--diff", "--base", "other-base", "--json"], root, NOW);
    expect((JSON.parse(overridden.stdout) as { changed: string[] }).changed).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("prints doctor's verdict and the missing-evidence caveat when nothing changed co-changes with anything else", () => {
    const repo = tinyRepo();
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: repo });
    appendCommits(repo, [{ files: ["c.ts"] }]);

    const result = runCli(["impact", "--diff"], repo, NOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("changed: 1 file(s)");
    expect(result.stdout).toContain("(none)");
    expect(result.stdout).toContain("history is degraded");
    expect(result.stdout).toContain("missing evidence, not evidence of absence");
  });

  it("--since still narrows the history window feeding the co-change graph, not the diff scope", () => {
    // The regression this guards: routing --since into DiffScope would give
    // it a second meaning depending on whether --diff is present. Here it
    // keeps its ONE meaning — narrowing analyze()'s history window — so an
    // old enough --since drops the a/b co-change pair from the graph
    // entirely, same as it would for `impact <path>`.
    const repo = repoWithCoupledBranch();
    const farFuture = runCli(["impact", "--diff", "--since", "2030-01-01", "--json"], repo, NOW);
    expect(farFuture.code).toBe(0);
    const answer = JSON.parse(farFuture.stdout) as { changed: string[]; source: unknown[] };
    expect(answer.changed).toEqual(["a.ts"]); // diff scope is unaffected
    expect(answer.source).toEqual([]); // but the co-change graph is now empty
  });
});
