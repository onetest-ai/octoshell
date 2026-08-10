import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { appendCommits, buildRepo } from "./fixtures/repo.js";
import { runNode } from "./fixtures/run-node.js";
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
  it("keeps every untouched module's clusters.json entry byte-identical and moves no map.md line but the changed module's own, while the touched module's entry and line do move", () => {
    // Three internally dense regions — the same "isolated community" shape
    // `e2e.test.ts` uses for M1's cluster-id-survival property, extended to
    // three regions and driven through the real `map` CLI command so the
    // artifacts under test are the ones actually written to disk. modB, the
    // module this test changes, co-changes with nothing outside itself; modA
    // and modC are linked (see below) so the rendered map has a dependency
    // line the confinement assertion can be wrong about.
    const region = (name: string, n: number): { files: string[] }[] =>
      Array.from({ length: n }, () => ({ files: [`${name}/a.ts`, `${name}/b.ts`, `${name}/c.ts`] }));

    // ONE cross-module coupling, so `map.md` actually HAS a "## Coupling"
    // section for the diff below to be confined over. Without it every region
    // is disconnected, `rollUp` drops every edge as intra-module, and the
    // section renders empty — so "the map.md diff is confined to the changed
    // module" would be asserted over a document whose only per-module content
    // is three bullet lines, and a regression that churned an untouched
    // module's dependency line would have nothing to churn.
    //
    // A DEDICATED file on each side, co-changed with nothing else. Coupling
    // two files that also carry their own region's churn produces a NEGATIVE
    // nPMI (they co-change far less often than their individual rates predict),
    // `edgeWeight` floors it to zero, and the section renders empty again —
    // verified: 4 commits over `modA/a.ts` + `modC/a.ts` yields no edge at all.
    const link = Array.from({ length: 4 }, () => ({ files: ["modA/link.ts", "modC/link.ts"] }));
    const repo = buildRepo([
      ...region("modA", 10),
      ...region("modB", 10),
      ...region("modC", 10),
      ...link,
    ]);

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

    // The Coupling section carries a real dependency line between two
    // UNTOUCHED modules, in both runs. Asserted explicitly, and before the
    // diff below rather than left implicit in it: the diff is only as strong
    // as the document it runs over, so if a future change to the fixture (or
    // to `rollUp`'s intra-module filter) empties this section again, that must
    // fail HERE and say so, not silently shrink the confinement claim to three
    // bullet lines while every assertion still passes.
    expect(firstMap).toContain("- modA ↔ modC (");
    expect(secondMap).toContain("- modA ↔ modC (");

    // THE confinement assertion: a real, POSITIONAL diff of the whole file.
    //
    // Not a set difference over the module bullets, which is what this was.
    // "The diff is confined to the changed module" is a claim about `git diff`
    // — about which LINES of a committed artifact move — and a set difference
    // cannot make it: it is blind to ORDER (modA and modC swapping places
    // renders a two-line diff on two untouched modules and leaves both sets
    // identical, which is exactly the committed-artifact churn A5b exists to
    // prevent, and exactly what `renderMap`'s PageRank ordering makes possible
    // the moment an edge weight shifts), and blind to every line that is not a
    // module bullet — the dependency lines above included.
    const firstFileLines = firstMap.split("\n");
    const secondFileLines = secondMap.split("\n");
    expect(secondFileLines.length).toBe(firstFileLines.length);

    /**
     * Repo-wide totals, the two lines a one-module change is ALLOWED to move.
     * They are counts over the whole history — "34 commits analysed" is not a
     * claim about any module — so a new commit changing them is the truth
     * changing, not churn. Every other line in the file is a per-module claim
     * (a bullet, a dependency edge) or fixed prose.
     */
    const isRepoWideStat = (line: string): boolean =>
      line.startsWith("- commits analysed:") || line.startsWith("- files in the co-change graph:");
    const isChangedModule = (line: string): boolean => line.startsWith("- **modB**");

    const changed = firstFileLines.flatMap((before, i) => {
      const after = secondFileLines[i] ?? "(line absent)";
      return after === before ? [] : [{ line: i + 1, before, after }];
    });
    const offending = changed.filter(
      (c) =>
        !(isRepoWideStat(c.before) && isRepoWideStat(c.after)) &&
        !(isChangedModule(c.before) && isChangedModule(c.after)),
    );
    expect(offending).toEqual([]);

    // Non-vacuity: modB's own line IS among the lines that moved, so the
    // filter above is not passing an empty diff off as confinement.
    expect(changed.some((c) => isChangedModule(c.before))).toBe(true);

    // Known limitation, deliberately not asserted away: the modA ↔ modC weight
    // above survives this diff because that pair's nPMI saturates at exactly
    // 1.0 (the two files co-change with each other and nothing else, so
    // p(a,b) === p(a) === p(b) whatever the repo-wide totals do). A
    // NON-saturated module edge would move, because nPMI normalises over
    // `PairTable.weightTotal` — the decayed mass of the WHOLE history — so
    // three commits in modB perturb the arithmetic behind every edge weight in
    // the file. That is a property of the weighting in M2's `weighEdges`, not
    // something a test can assert away, and it is the reason a real committed
    // `map.md` will show weight-only churn on unrelated edges. Stated here so
    // the next such report is read as this known property rather than as a new
    // defect — and so nobody strengthens the filter above into a lie.
  });
});

describe("end-to-end: the bundled .mjs against this repo's own history", () => {
  const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  // packages/graph -> repo root, two levels up.
  const REPO_ROOT = join(PKG_ROOT, "..", "..");

  it(
    "runs doctor under bare node against octoshell's own repo and reports degraded, naming thin history as the cause",
    () => {
      // Built by the SAME script `pnpm --filter @octoshell/graph bundle`
      // invokes — never a stale artifact left from a previous run, and never a
      // second, hand-written copy of the bundling rule.
      //
      // Built STRAIGHT INTO this test's own temp directory, not into
      // `dist/octograph.mjs` and copied out. Two things fall out of that, and
      // both matter:
      //
      //  - `dist/octograph.mjs` has exactly one writer in the suite
      //    (`bundle.test.ts`, which is about the shipped default path). Vitest
      //    runs test files in parallel, so building it here too raced that
      //    file's own build and copy over the same bytes — an intermittent,
      //    CI-only torn read that passes every local run.
      //  - Under the OS temp dir there is no `node_modules` anywhere up the
      //    chain, so a bare specifier esbuild failed to inline cannot resolve.
      //    Node resolves those against the importing FILE's directory, never
      //    `cwd` — and this run's cwd is the real octoshell repo root, which
      //    does have a node_modules tree, so running from inside the package
      //    would prove nothing. (That property is bundle.test.ts's subject;
      //    this test is about the CONTENT of the report against a real,
      //    currently-thin-history repo. Only the executable is isolated, not
      //    the repo it runs against.)
      const isolated = join(mkdtempClean("octograph-gate-bundle-"), "octograph.mjs");
      execFileSync("node", ["scripts/bundle.mjs", isolated], { cwd: PKG_ROOT, stdio: "pipe" });
      expect(existsSync(isolated)).toBe(true);
      expect(existsSync(join(REPO_ROOT, ".git"))).toBe(true);

      const result = runNode([isolated, "doctor", "--json"], REPO_ROOT);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      // Named before it is parsed: `JSON.parse("")` throws "Unexpected end of
      // JSON input", which says nothing about a CLI that exited before it
      // printed. The stderr it did print is the diagnosis.
      expect(result.stdout, `octograph exited ${result.code}: ${result.stderr}`).not.toBe("");
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
