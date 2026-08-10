import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { appendCommits, buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import type { DriftRow } from "../src/drift.js";
import type { Report } from "../src/doctor.js";
import type { StoredGraph } from "../src/artifact.js";

/**
 * T3.6 — the mission's own end-to-end gate: prove what M3 put at risk,
 * together, against artifacts actually written to disk rather than the
 * in-memory `Analysis`/`Report` a single unit test happens to hold onto.
 * Every unit-level suite in this package (drift.test.ts, noise.test.ts,
 * doctor.test.ts, cli.test.ts, bundle.test.ts) already covers its own
 * function in isolation; this file is the one place that runs the REAL CLI
 * end to end and reads the REAL files it wrote back off disk before making
 * a claim about them.
 */

const NOW = Date.UTC(2026, 0, 1);

describe("end-to-end: the noise floor survives the full drift pipeline", () => {
  it(
    "excludes a manifest-lockfile pair from every one of the five supported ecosystems and every test-subject pair, while a planted cross-boundary pair survives",
    () => {
      // Every pair below repeats 3x — comfortably above the default
      // `minSupport` of 2 — and each pair's two files never co-occur with
      // anything else, so each edge's nPMI is strongly positive and would
      // top an unfiltered ranking. Manifests sit in their own module
      // directory while every lockfile sits at the repo root: `governs`
      // (spine.ts) treats a root lockfile as governing any manifest
      // beneath it, so each pair is classified `mechanical` even though its
      // two endpoints resolve to DIFFERENT declared modules — proving the
      // noise floor, not an incidental intra-module skip, is what suppresses
      // it. Same reasoning for the test-subject pair: subject and test sit
      // in different top-level directories.
      const rep = (files: string[]) => [
        { files },
        { files, daysAgo: 1 },
        { files, daysAgo: 2 },
      ];
      const repo = buildRepo([
        // Planted cross-boundary pair — no manifest, no test, two different
        // declared modules, nothing in the declared spine already relates
        // them (there is no Graphify data in this fixture, so `imports` is
        // always empty). This is the one row `drift` must surface.
        ...rep(["modP/core.ts", "modQ/handler.ts"]),

        // npm ecosystem
        ...rep(["svcNpm/package.json", "package-lock.json"]),
        // Cargo ecosystem
        ...rep(["svcCargo/Cargo.toml", "Cargo.lock"]),
        // Python ecosystem (uv.lock)
        ...rep(["svcPy/pyproject.toml", "uv.lock"]),
        // Go ecosystem
        ...rep(["svcGo/go.mod", "go.sum"]),
        // Ruby ecosystem
        ...rep(["svcRuby/Gemfile", "Gemfile.lock"]),

        // Test-subject pair, cross-module.
        ...rep(["srcApp/thing.ts", "qaSuite/thing.test.ts"]),
      ]);

      const result = runCli(["drift", "--json"], repo, NOW);
      expect(result.code).toBe(0);
      const rows = JSON.parse(result.stdout) as DriftRow[];

      const hasPair = (x: string, y: string): boolean =>
        rows.some((r) => (r.a === x && r.b === y) || (r.a === y && r.b === x));

      // The planted finding survives.
      expect(hasPair("modP/core.ts", "modQ/handler.ts")).toBe(true);

      // Every manifest-lockfile pair, across all five ecosystems, does not.
      expect(hasPair("svcNpm/package.json", "package-lock.json")).toBe(false);
      expect(hasPair("svcCargo/Cargo.toml", "Cargo.lock")).toBe(false);
      expect(hasPair("svcPy/pyproject.toml", "uv.lock")).toBe(false);
      expect(hasPair("svcGo/go.mod", "go.sum")).toBe(false);
      expect(hasPair("svcRuby/Gemfile", "Gemfile.lock")).toBe(false);

      // Nor does the test-subject pair.
      expect(hasPair("srcApp/thing.ts", "qaSuite/thing.test.ts")).toBe(false);
    },
  );
});

describe("end-to-end: doctor's three states via the CLI, with the exit codes each requires", () => {
  it("returns ok/degraded/blocked with matching exit codes across three fixture repos, and rejects an unknown flag before any analysis runs", () => {
    // (1) blocked — no .git at all.
    const blocked = runCli(["doctor", "--json"], mkdtempClean("octograph-gate-nogit-"), NOW);
    const blockedReport = JSON.parse(blocked.stdout) as Report;
    expect(blockedReport.status).toBe("blocked");
    expect(blocked.code).not.toBe(0);

    // (2) degraded — a real repo, history below config.minCommits (default 200).
    const degradedRepo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["c.ts", "d.ts"] }]);
    const degraded = runCli(["doctor", "--json"], degradedRepo, NOW);
    const degradedReport = JSON.parse(degraded.stdout) as Report;
    expect(degradedReport.status).toBe("degraded");
    expect(degraded.code).not.toBe(0);

    // (3) ok — history clears the (overridden, for a small fixture) bar.
    const okRepo = buildRepo(
      Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })),
    );
    const ok = runCli(["doctor", "--min-commits", "10", "--json"], okRepo, NOW);
    const okReport = JSON.parse(ok.stdout) as Report;
    expect(okReport.status).toBe("ok");
    expect(ok.code).toBe(0);

    // Every non-ok state's exit code differs from ok's — the "matching exit
    // codes" half of the criterion, not just "non-zero".
    expect(blocked.code).not.toBe(ok.code);
    expect(degraded.code).not.toBe(ok.code);

    // An unrecognised flag exits the CLI with 2 before any of the above runs.
    const unknown = runCli(["doctor", "--not-a-real-flag"], okRepo, NOW);
    expect(unknown.code).toBe(2);
  });
});

describe("end-to-end: a one-module change confines the map.md and clusters.json diff to that module, read off disk", () => {
  it("keeps every untouched module's clusters.json entry byte-identical and its map.md bullet line unchanged, while the touched module's own entry and line move", () => {
    // Three regions, each internally dense and never co-changing with either
    // of the other two — the same "isolated, disconnected community" shape
    // `e2e.test.ts` uses for M1's cluster-id-survival property, extended to
    // three regions and driven through the real `map` CLI command so the
    // artifacts under test are the ones actually written to disk.
    const region = (name: string, n: number): { files: string[] }[] =>
      Array.from({ length: n }, () => ({ files: [`${name}/a.ts`, `${name}/b.ts`, `${name}/c.ts`] }));
    const repo = buildRepo([...region("modA", 10), ...region("modB", 10), ...region("modC", 10)]);

    // `map`'s own output directory must not become an input to the NEXT
    // `map` run's history: without this, `appendCommits`' `git add -A`
    // below sweeps up the first run's `.octograph/map.md` and
    // `clusters.json` as new tracked files, and they surface as a bogus
    // fourth ".octograph" module in the second run — an artifact of this
    // fixture never committing its own output, not a real octograph defect
    // (a real repo gitignores its out directory, exactly as this one's own
    // `.octobots/` is gitignored per CLAUDE.md).
    //
    // Committed on its own, as a single-file commit, rather than left
    // untracked or added via `appendCommits` (which would overwrite its
    // content with fixture placeholder bytes): `harvest` drops any commit
    // touching fewer than two files, so a solo `.gitignore` commit is
    // invisible to the whole pipeline — never a module member, never part
    // of anyone's co-change count — while an UNCOMMITTED `.gitignore` would
    // itself ride along on modB's next multi-file commit below and show up
    // as a bogus root-level module instead.
    writeFileSync(join(repo, ".gitignore"), ".octograph/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "chore: ignore build output"], {
      cwd: repo,
      stdio: "pipe",
    });

    const first = runCli(["map"], repo, NOW);
    expect(first.code).toBe(0);
    const mapPath = join(repo, ".octograph", "map.md");
    const clustersPath = join(repo, ".octograph", "clusters.json");
    const firstMap = readFileSync(mapPath, "utf8");
    const firstStored = JSON.parse(readFileSync(clustersPath, "utf8")) as StoredGraph;

    // Touch modB only: grow its declared membership with a new file that
    // co-changes with modB's existing files, several times over.
    appendCommits(repo, [
      { files: ["modB/a.ts", "modB/b.ts", "modB/c.ts", "modB/d.ts"] },
      { files: ["modB/a.ts", "modB/b.ts", "modB/c.ts", "modB/d.ts"] },
      { files: ["modB/a.ts", "modB/b.ts", "modB/c.ts", "modB/d.ts"] },
    ]);

    const second = runCli(["map"], repo, NOW);
    expect(second.code).toBe(0);
    const secondMap = readFileSync(mapPath, "utf8");
    const secondStored = JSON.parse(readFileSync(clustersPath, "utf8")) as StoredGraph;

    // --- clusters.json, read back off disk ---
    // The cluster that owns a given member path, keyed by id — as written,
    // never re-derived from the in-memory Analysis.
    const clusterOwning = (stored: StoredGraph, member: string): [string, string[]] | undefined =>
      Object.entries(stored.clusters).find(([, members]) => members.includes(member));

    const firstA = clusterOwning(firstStored, "modA/a.ts");
    const secondA = clusterOwning(secondStored, "modA/a.ts");
    const firstC = clusterOwning(firstStored, "modC/a.ts");
    const secondC = clusterOwning(secondStored, "modC/a.ts");
    if (!firstA || !secondA || !firstC || !secondC) {
      throw new Error("expected modA and modC to each form their own cluster in both runs");
    }
    // Same cluster id, same sorted member-path list, for every module the
    // change did not touch.
    expect(secondA[0]).toBe(firstA[0]);
    expect(secondA[1]).toEqual(firstA[1]);
    expect(secondC[0]).toBe(firstC[0]);
    expect(secondC[1]).toEqual(firstC[1]);

    // The changed module's own entry actually moved — otherwise the two
    // assertions above would be vacuously true of a run that touched nothing.
    const firstB = clusterOwning(firstStored, "modB/a.ts");
    const secondB = clusterOwning(secondStored, "modB/a.ts");
    if (!firstB || !secondB) throw new Error("expected modB to form its own cluster in both runs");
    expect(secondB[1]).not.toEqual(firstB[1]);
    expect(secondB[1]).toContain("modB/d.ts");

    // The clusters.json diff, over EVERY id present in both runs, is
    // confined to modB's id — no third, untouched cluster moved either.
    for (const [id, members] of Object.entries(firstStored.clusters)) {
      if (id === firstB[0]) continue;
      expect(secondStored.clusters[Number(id)], `cluster ${id}`).toEqual(members);
    }

    // --- map.md, read back off disk ---
    // Each module's own rendered bullet line, keyed by module name.
    const moduleLines = (text: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const line of text.split("\n")) {
        const m = /^- \*\*([^*]+)\*\*/.exec(line);
        if (m?.[1] !== undefined) out.set(m[1], line);
      }
      return out;
    };
    const firstLines = moduleLines(firstMap);
    const secondLines = moduleLines(secondMap);

    // Same three modules, both runs.
    expect([...secondLines.keys()].sort()).toEqual([...firstLines.keys()].sort());

    // Untouched modules' lines are byte-identical.
    expect(secondLines.get("modA")).toBe(firstLines.get("modA"));
    expect(secondLines.get("modC")).toBe(firstLines.get("modC"));

    // modB's line changed — proof the run actually re-rendered, not a
    // vacuous pass.
    expect(secondLines.get("modB")).not.toBe(firstLines.get("modB"));

    // The diff over the FULL set of module bullet lines is confined to
    // modB: the only line removed is modB's old line, the only line added
    // is modB's new one. (The header's global stats — commit/file counts —
    // are deliberately excluded here: they are repo-wide totals, not a
    // per-module claim, and the "## Modules" section is what "the map.md
    // diff is confined to the changed module" is actually about.)
    const firstSet = new Set(firstLines.values());
    const secondSet = new Set(secondLines.values());
    const removed = [...firstSet].filter((l) => !secondSet.has(l));
    const added = [...secondSet].filter((l) => !firstSet.has(l));
    expect(removed).toEqual([firstLines.get("modB")]);
    expect(added).toEqual([secondLines.get("modB")]);
  });
});

describe("end-to-end: the bundled .mjs against this repo's own history", () => {
  const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const BUNDLE_PATH = join(PKG_ROOT, "dist", "octograph.mjs");
  // packages/graph -> repo root, two levels up.
  const REPO_ROOT = join(PKG_ROOT, "..", "..");

  interface Run {
    code: number;
    stdout: string;
    stderr: string;
  }

  /** Same shape as bundle.test.ts's helper: `doctor` legitimately exits
   *  non-zero for a degraded/blocked report, so capture the exit rather
   *  than treat it as a thrown test failure. */
  function runNode(args: string[], cwd: string): Run {
    try {
      const stdout = execFileSync("node", args, { cwd, stdio: "pipe" }).toString();
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number | null; stdout: Buffer; stderr: Buffer };
      return {
        code: e.status ?? 1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
  }

  it(
    "runs doctor under bare node against octoshell's own repo and reports degraded, naming thin history as the cause",
    () => {
      // Freshly built by the SAME script `pnpm --filter @octoshell/graph
      // bundle` invokes — never a stale artifact left from a previous run.
      execFileSync("node", ["scripts/bundle.mjs"], { cwd: PKG_ROOT, stdio: "pipe" });
      expect(existsSync(BUNDLE_PATH)).toBe(true);
      expect(existsSync(join(REPO_ROOT, ".git"))).toBe(true);

      // Copied out, exactly as bundle.test.ts does, so a bare specifier
      // esbuild failed to inline cannot resolve against this package's own
      // node_modules — this run's `cwd` (the real octoshell repo root) does
      // have a node_modules tree, so running the bundle IN PLACE would prove
      // nothing about self-containment; that property is bundle.test.ts's
      // job. This test is about the CONTENT of the report against a real,
      // large, currently-thin-history repo, so only the isolation of the
      // executable itself is copied, not the target it runs against.
      const isolated = join(mkdtempClean("octograph-gate-bundle-"), "octograph.mjs");
      copyFileSync(BUNDLE_PATH, isolated);

      const result = runNode([isolated, "doctor", "--json"], REPO_ROOT);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      const report = JSON.parse(result.stdout) as Report;

      // This assertion is tied to octoshell's OWN current commit history
      // (well under the default 200-commit bar as of this task) — it is the
      // mission's own acceptance criterion, not a synthetic fixture, and it
      // will need revisiting the day this repo's analysable commit count
      // crosses config.minCommits.
      expect(report.status).toBe("degraded");
      expect(result.code).not.toBe(0);

      const history = report.checks.find((c) => c.name === "history depth");
      expect(history).toBeDefined();
      expect(history?.state).toBe("warn");
      expect(history?.detail ?? "").toMatch(/analysable commits/);
      expect(history?.fix ?? "").not.toBe("");
    },
    30_000,
  );
});
