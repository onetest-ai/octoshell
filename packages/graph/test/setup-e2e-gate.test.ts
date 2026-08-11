import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { runSetup, type SetupIO } from "../src/setup.js";
import { buildRepo, type CommitSpec } from "./fixtures/repo.js";
import { runNode } from "./fixtures/run-node.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/**
 * T5.4 — M5's own end-to-end gate, mirroring `e2e-gate.test.ts` (M3) and
 * `bundle.test.ts`: every other suite in this mission (`setup.test.ts`,
 * `setup-io.test.ts`) drives `runSetup` in-process against a fake port, or
 * the real `SetupIO` against a harmless real binary. Neither ever launches
 * `octograph setup` as a subprocess with a human's scripted answer on the
 * other end of a real pipe — which is the one thing `setup` is FOR. This
 * file is that exercise: the REAL bin (`bin/octograph.mjs`, and the bundled
 * `.mjs` the pack ships), fed stdin the way M6's terminal will, with `uv`
 * controlled through `PATH` rather than assumed absent or present on
 * whatever machine happens to run this suite.
 *
 * NEVER performs a real `uv tool install`, anywhere in this file — see the
 * per-scenario comments for how each one avoids it. The suite has to pass
 * offline, on a machine with no `uv` at all, without mutating the
 * developer's own tooling; a scenario that only happens to pass BECAUSE the
 * dev box has `uv` installed (or doesn't) would be exactly the kind of
 * environment-dependent test this rule exists to forbid.
 */

const NOW = Date.UTC(2026, 0, 1);

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PKG_ROOT, "src");

/**
 * `bin/octograph.mjs` imports `../src/cli.js` — a specifier that resolves
 * under `tsc`'s NodeNext rules but names a file that is never actually
 * written there (`src/` holds only `.ts`; the compiled `.js` lands in
 * `dist/`, and `bin/octograph.mjs` is never on the path that reads it).
 * Running the bin unbundled under bare node throws `ERR_MODULE_NOT_FOUND`
 * before it prints a single line — the SAME failure `bundle.test.ts` exists
 * to catch when esbuild leaves a dependency un-inlined, just for a
 * different reason. "The real bin" a shell invocation of `octograph setup`
 * or M6's terminal actually runs is always this bundled form, built by the
 * SAME `scripts/bundle.mjs` the package's own `bundle` script invokes — so
 * every scenario in this file drives THAT, never `bin/octograph.mjs`
 * directly. Built straight into a fresh `mkdtempClean` directory per call,
 * never the shared `dist/octograph.mjs`: `bundle.test.ts` and
 * `e2e-gate.test.ts` both write there too, and vitest runs test FILES in
 * parallel, so two writers of the same path race.
 */
function buildBundle(): string {
  const isolated = join(mkdtempClean("octograph-setup-e2e-"), "octograph.mjs");
  execFileSync("node", ["scripts/bundle.mjs", isolated], { cwd: PKG_ROOT, stdio: "pipe" });
  return isolated;
}

/** The lookup executable `setup-io.ts`'s own `which()` spawns — the same
 *  platform split, because this file has to put THAT binary's directory on
 *  the child's PATH (see `controlledPath`). */
const LOOKUP = process.platform === "win32" ? "where" : "which";

/**
 * The absolute directory a real executable resolves to on THIS machine's
 * real, unmodified `PATH` — read once, before any scenario below starts
 * overriding `process.env.PATH`. `node`'s own directory comes straight off
 * `process.execPath`; every other lookup goes through `which`/`where`, the
 * same primitive `setup-io.ts`'s real `which()` uses.
 */
function resolveBinDir(bin: string): string {
  const out = execFileSync(LOOKUP, [bin]).toString();
  const first = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === undefined) {
    throw new Error(`test setup: could not resolve \`${bin}\` on this machine's PATH`);
  }
  return dirname(first);
}

const NODE_DIR = dirname(process.execPath);
const GIT_DIR = resolveBinDir("git");
/**
 * The directory holding `which`/`where` ITSELF, and the reason it is a
 * first-class member of every controlled `PATH` below rather than something
 * inherited by luck.
 *
 * `setup-io.ts`'s `which()` does not read `PATH` in-process — it SPAWNS
 * `which`/`where` and reads the exit code, treating any non-zero (including
 * a spawn that failed with `ENOENT` because the lookup binary itself could
 * not be resolved) as "not found". So a child handed a `PATH` without this
 * directory reports `uv` absent no matter what is actually installed. That
 * is not a hypothetical: with `PATH` set to node's dir + git's dir + a
 * directory containing a real, executable `uv`, the bundled bin printed
 * "`uv` not found on PATH" and exited 1 — the "uv absent" verdict produced
 * by a broken lookup rather than by an absent `uv`.
 *
 * On this repo's CI (and on a macOS box with Apple's git) `GIT_DIR` happens
 * to be `/usr/bin`, which also holds `which`, so the omission was invisible.
 * On any layout where git or node come from a package manager that installs
 * elsewhere (Homebrew's `/opt/homebrew/bin`, a devcontainer, nvm alone) the
 * "uv absent" scenario below would have passed VACUOUSLY — for a reason
 * having nothing to do with `uv` — and the refusal scenario would have
 * failed for a reason having nothing to do with the product.
 */
const LOOKUP_DIR = resolveBinDir(LOOKUP);

/** Exactly the real directories every scenario's `PATH` is built from —
 *  never the ambient `PATH`, so `uv`'s presence on the developer's own
 *  machine cannot decide what these scenarios test. */
const REAL_DIRS = [NODE_DIR, GIT_DIR, LOOKUP_DIR];

/**
 * Refuses to run a scenario if `uv` (or, on Windows, `uv.exe`) actually lives
 * in one of the directories a scenario is about to put on the child's
 * `PATH`. This is the backstop for the one way `REAL_DIRS` could still go
 * wrong: a machine where the package manager that installed `node`, `git` or
 * `which` also dropped `uv` into the SAME directory (verified NOT the case in
 * a real Homebrew/nvm layout, but asserted here rather than assumed).
 */
function assertNoRealUv(dirs: string[]): void {
  const names = process.platform === "win32" ? ["uv.exe", "uv.cmd", "uv.bat"] : ["uv"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        throw new Error(
          `test setup: refusing to run — ${candidate} exists. A scenario below builds a ` +
            "PATH out of this directory expecting `uv` to be absent from it; on this " +
            "machine it is not, which would make the \"uv absent\" scenario spawn a REAL " +
            "`uv`. This is an environment problem, not a product defect.",
        );
      }
    }
  }
}

/** The ONE spelling of the child's `PATH`: the three real directories, plus
 *  whatever throwaway decoy directories this scenario controls. Every
 *  scenario builds its `PATH` through here, so the "uv absent" run and the
 *  "uv present, decoy on PATH" run differ in exactly one thing — the decoy —
 *  and neither can quietly drift onto a different base. */
function controlledPath(...extra: string[]): string {
  assertNoRealUv(REAL_DIRS);
  return [...REAL_DIRS, ...extra].join(delimiter);
}

/**
 * Throwaway executables that PROVE, rather than merely being absent, whether
 * they were ever actually run: `which`/`where` sees them on `PATH`, but a
 * body only writes its marker if something actually EXECUTES it.
 *
 * Used two ways below. As a decoy `uv`, it is what lets the refusal scenario
 * assert "nothing was installed" against a run where `uv` really was
 * findable — and what lets the consent scenario prove that assertion is not
 * vacuous, without ever running a real `uv tool install`. As decoy `sh` and
 * `curl`, it is what turns "no process was spawned" from a title into a
 * checked claim: the forbidden fallback this package's safety rules exist to
 * prevent (piping astral.sh's `install.sh` to a shell when `uv` is missing)
 * would run one of exactly those two.
 *
 * POSIX only (`#!/bin/sh`), matching this suite's CI (`ubuntu-latest`).
 */
function decoys(names: string[]): { dir: string; ran: (name: string) => boolean } {
  const dir = mkdtempClean("octograph-decoy-");
  for (const name of names) {
    const marker = join(dir, `${name}.marker`);
    const scriptPath = join(dir, name);
    writeFileSync(scriptPath, `#!/bin/sh\necho spawned >> "${marker}"\nexit 0\n`);
    chmodSync(scriptPath, 0o755);
  }
  return { dir, ran: (name) => existsSync(join(dir, `${name}.marker`)) };
}

/**
 * History deep enough that, combined with `octograph.yaml`'s `minCommits`
 * override below, `historyIsThin` never fires — and, unlike the flat
 * `a{i}.ts`/`b{i}.ts` shape `setup.test.ts` uses, SPREAD ACROSS DIRECTORIES
 * so the map this mission's build step produces is worth comparing.
 *
 * That is not cosmetic. The declared spine with no Graphify output is
 * directories, so a fixture whose files all sit at the repo root analyses to
 * one module, zero module edges and an empty coupling section — and the
 * build-verification test below, the one criterion the tech-lead review
 * added precisely because nothing else in this mission checks the artifact
 * `setup` claims to have written, would have been comparing two nearly
 * empty documents while asserting it had run "over a non-trivial map". This
 * shape yields three modules, two coupling edges and two working sets; the
 * test asserts that floor rather than trusting this comment.
 */
const COMMITS: CommitSpec[] = [
  ...Array.from({ length: 4 }, () => ({ files: ["api/handler.ts", "core/service.ts"] })),
  ...Array.from({ length: 4 }, () => ({
    files: ["api/router.ts", "api/schema.ts", "ui/view.ts"],
  })),
];

/**
 * A fixture repo with real git history AND a committed `octograph.yaml`
 * overriding `minCommits` — the real bin loads config off disk
 * (`loadConfig(repoRoot)` in `bin/octograph.mjs`), unlike the unit-level
 * `setup.test.ts`, which hands `runSetup` an in-memory `Config` override
 * directly. The config commit touches exactly one file, which `harvest`
 * drops outright (`files.length < 2`) — it does not count toward
 * `analysable`, exactly like `e2e-gate.test.ts`'s own `.gitignore` commit,
 * and it is why two repos built by this function are byte-identical as far
 * as anything `map` reads is concerned even though their config commit
 * carries a wall-clock date.
 */
function e2eRepo(): string {
  const repo = buildRepo(COMMITS);
  writeFileSync(join(repo, "octograph.yaml"), "minCommits: 5\n");
  execFileSync("git", ["add", "octograph.yaml"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "-m", "chore: configure octograph for the fixture"], {
    cwd: repo,
    stdio: "pipe",
  });
  return repo;
}

/**
 * Every TRACKED path with a hash of its CONTENT, in the git-decided order —
 * criterion 3's "byte-identical" taken literally, rather than inferred from
 * a path listing (which cannot see an edit) or from `git status` alone
 * (which answers off git's stat cache). Paired with `trackedStatus` below,
 * which catches what a content hash cannot: a staged change, or a tracked
 * file deleted outright.
 */
function trackedSnapshot(root: string): string {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter((f) => f !== "");
  return files
    .map((f) => {
      const bytes = readFileSync(join(root, f));
      return `${f}\t${createHash("sha256").update(bytes).digest("hex")}`;
    })
    .join("\n");
}

function trackedStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
  }).toString();
}

/** Swaps `process.env.PATH` for the child this synchronous callback spawns,
 *  and restores it before returning — even on throw. Every call site below
 *  is a single synchronous `execFileSync` (via `runNode`), so there is no
 *  `await` between the swap and the restore for another test in this file
 *  (vitest runs `it()`s in one file sequentially by default) to observe the
 *  overridden value. */
function withPath<T>(pathValue: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

describe("end-to-end: octograph setup, driven as a real subprocess with scripted stdin", () => {
  it("answering NO to the install prompt: no install runs, and the exit code and postflight are correct", () => {
    const bundle = buildBundle();
    const repo = e2eRepo();
    const decoy = decoys(["uv"]);

    const snapshotBefore = trackedSnapshot(repo);
    const statusBefore = trackedStatus(repo);
    expect(statusBefore).toBe(""); // sanity: the fixture starts clean

    const result = withPath(controlledPath(decoy.dir), () =>
      runNode([bundle, "setup"], repo, { input: "n\n" }),
    );

    // The prompt REACHED the human — i.e. `which("uv")` really did find the
    // decoy on PATH. Without this line the "nothing was installed"
    // assertion underneath could be satisfied by a run that never got as
    // far as asking.
    expect(result.stdout).toContain("Install Graphify now via");

    // The decoy `uv` is ON PATH, but its body never ran: nothing was
    // installed. Non-vacuous because the consent scenario below runs the
    // SAME decoy through the SAME PATH and proves the marker does appear
    // when the answer is yes.
    expect(decoy.ran("uv")).toBe(false);
    expect(result.stdout).toContain("octograph: skipping Graphify install — continuing without it.");
    expect(result.stdout).not.toContain("uv tool install graphifyy` failed");
    expect(result.stdout).not.toContain("uv tool install graphifyy` succeeded");

    // The postflight, and the exit code it implies: an otherwise-healthy
    // repo with only the optional `graphify` check unmet still exits 0.
    expect(result.stdout).toContain("octograph: setup finished — final state:");
    expect(result.stdout).toContain("status: ok");
    expect(result.stdout).toContain("[missing] graphify");
    expect(result.code).toBe(0);

    // No tracked file moved, in this or any other scenario in this file.
    expect(trackedSnapshot(repo)).toBe(snapshotBefore);
    expect(trackedStatus(repo)).toBe(statusBefore);
  });

  it("answering YES does spawn the install command — the positive control that makes the refusal assertion mean something", () => {
    // Never a real `uv tool install`: the only `uv` on this child's PATH is
    // the decoy, and `assertNoRealUv` (inside `controlledPath`) refuses to
    // run if a real one is sitting in any of the real directories. What
    // this scenario proves is the half of the consent rule the refusal
    // scenario CANNOT: that `INSTALL_ARGV` is actually reached and executed
    // on a yes. Delete the `io.exec` call from `setup.ts` entirely and the
    // refusal test above stays green; this one goes red.
    const bundle = buildBundle();
    const repo = e2eRepo();
    const decoy = decoys(["uv"]);

    const snapshotBefore = trackedSnapshot(repo);
    const statusBefore = trackedStatus(repo);

    const result = withPath(controlledPath(decoy.dir), () =>
      runNode([bundle, "setup"], repo, { input: "y\n" }),
    );

    expect(result.stdout).toContain("Install Graphify now via");
    expect(decoy.ran("uv")).toBe(true);

    // The decoy exits 0 and installs nothing, which is precisely the
    // half-changed machine `setup.ts` refuses to report as a success: an
    // exit 0 that left no `graphify` on PATH is named as such, and the run
    // exits non-zero rather than handing CI a green gate over a machine
    // that was not set up.
    expect(result.stdout).toContain("exited 0 but left no `graphify` on PATH");
    expect(result.stdout).not.toContain("uv tool install graphifyy` succeeded");
    expect(result.stdout).toContain("octograph: setup finished — final state:");
    expect(result.code).toBe(1);

    // An install that ran is still not licence to touch the repo.
    expect(trackedSnapshot(repo)).toBe(snapshotBefore);
    expect(trackedStatus(repo)).toBe(statusBefore);
  });

  it("with uv absent from PATH, the install URL is printed, the prompt never fires, and nothing is spawned", () => {
    const bundle = buildBundle();
    const repo = e2eRepo();
    // No `uv` decoy this time — `uv` is not anywhere on this PATH, full
    // stop. `sh` and `curl` ARE here, as markers: the one forbidden way to
    // "fix" a missing `uv` transparently is to fetch astral.sh's
    // `install.sh` and pipe it to a shell, and that edit would run one of
    // these two. Absent them, "nothing was spawned" would be a claim this
    // test never checked.
    const decoy = decoys(["sh", "curl"]);

    const snapshotBefore = trackedSnapshot(repo);
    const statusBefore = trackedStatus(repo);

    // Scripted "yes" on purpose: proves the absence check runs BEFORE the
    // prompt, per `setup.ts`'s own ordering. If that ever regressed to
    // prompt-first, this "yes" would need `uv` to install something, and
    // there is none on this PATH to do it — the run would hang on stdin
    // instead of exiting, and this test would time out rather than pass by
    // accident.
    const result = withPath(controlledPath(decoy.dir), () =>
      runNode([bundle, "setup"], repo, { input: "y\n" }),
    );

    expect(result.stdout).toContain(
      "octograph: `uv` not found on PATH — install it yourself from " +
        "https://docs.astral.sh/uv/getting-started/installation/",
    );
    // The prompt text never appears — it was never reached.
    expect(result.stdout).not.toContain("Install Graphify now via");
    expect(result.code).toBe(1);

    // Nothing was spawned to work around the absence. This verdict is
    // attributable to `uv` itself and not to a lookup that could not run:
    // the PATH here is `controlledPath()`'s base, the SAME base on which
    // the two scenarios above find a decoy `uv` and reach the prompt.
    const spawnedShell =
      "a decoy `sh`/`curl` on the child's PATH was EXECUTED during a run where `uv` was " +
      "absent. If setup grew a fallback that fetches astral.sh's install.sh and pipes it " +
      "to a shell, that is the affordance this package's safety rules forbid — revert it. " +
      "If instead some unrelated child (git, node) legitimately needed a shell here, this " +
      "decoy is the wrong instrument here, and the product is not at fault.";
    expect(decoy.ran("sh"), spawnedShell).toBe(false);
    expect(decoy.ran("curl"), spawnedShell).toBe(false);

    expect(trackedSnapshot(repo)).toBe(snapshotBefore);
    expect(trackedStatus(repo)).toBe(statusBefore);
  });

  it(
    "the pack bundle runs setup under bare node with no node_modules present",
    () => {
      const isolated = buildBundle();
      expect(existsSync(isolated)).toBe(true);

      const repo = e2eRepo();
      // Under the OS temp dir there is no `node_modules` anywhere up the
      // chain — the same isolation `bundle.test.ts` relies on: any
      // specifier esbuild left un-inlined fails to resolve here, where
      // running from inside the package (which DOES have a node_modules
      // tree) would prove nothing.
      expect(existsSync(join(repo, "node_modules"))).toBe(false);

      const decoy = decoys(["uv"]);

      const snapshotBefore = trackedSnapshot(repo);
      const statusBefore = trackedStatus(repo);

      const result = withPath(controlledPath(decoy.dir), () =>
        runNode([isolated, "setup"], repo, { input: "n\n" }),
      );

      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout).toContain("octograph: setup finished — final state:");
      expect(result.code).toBe(0);
      expect(decoy.ran("uv")).toBe(false);

      expect(trackedSnapshot(repo)).toBe(snapshotBefore);
      expect(trackedStatus(repo)).toBe(statusBefore);
    },
    30_000,
  );
});

describe("end-to-end: verifying the BUILD, not just the postflight", () => {
  /**
   * Every other check in this mission (prompts, installs, exit codes) tests
   * `setup` around the build step without ever reading the artifact it
   * claims to have produced. This is the one that does: a full-consent
   * `runSetup`, against `map`'s own output on an IDENTICAL twin repo, at
   * the SAME `now`.
   *
   * A twin rather than a second run against the same directory, because
   * `map` is deliberately NOT idempotent in the way that would allow it:
   * `runMapCommand` reads the previous `clusters.json` back as
   * `previousClusters` to pin cluster ids across runs (stability.ts), so a
   * second run on the same repo has an input the first one did not. The
   * twin is byte-identical where it counts — `buildRepo` writes fixed
   * content and fixed author/committer dates, and the only wall-clock
   * commit (`octograph.yaml`, one file) is dropped by `harvest` before
   * anything reads a date.
   *
   * Driven through `runSetup` directly with a FAKE port — never the real
   * bin with a scripted "y" — because a real bin run with consent would
   * reach `setup-io.ts`'s real `exec()` and actually invoke
   * `uv tool install graphifyy`, which this suite must never do. (That the
   * consent path really does spawn its argv is proven above, against a
   * decoy `uv`.) The fake's `exec()` is a no-op — which mirrors what a real
   * `uv tool install` does to THIS repo: nothing, since it installs an
   * executable onto the user's machine, not a file into the fixture — so
   * both repos reach `analyze()` with identical inputs: no
   * `graphify-out/graph.json` on either side.
   */
  it("a full-consent runSetup produces map.md and clusters.json equal to what `map` alone produces on an identical repo at the same now", async () => {
    const repoViaSetup = e2eRepo();
    const repoViaMapOnly = e2eRepo();

    const snapshotBefore = trackedSnapshot(repoViaSetup);
    const statusBefore = trackedStatus(repoViaSetup);

    const io: SetupIO = {
      prompt: async () => true,
      log: () => {
        /* not under test here — the other tests in this file assert on the
         * real bin's postflight text */
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      which: async (file) => `/usr/bin/${file}`,
    };

    const config = loadConfig(repoViaSetup);
    const code = await runSetup(repoViaSetup, config, NOW, io);
    expect(code).toBe(0);

    const mapOnly = runCli(["map"], repoViaMapOnly, NOW);
    expect(mapOnly.code).toBe(0);

    const setupMap = readFileSync(join(repoViaSetup, ".octograph", "map.md"), "utf8");
    const mapOnlyMap = readFileSync(join(repoViaMapOnly, ".octograph", "map.md"), "utf8");
    expect(setupMap).toBe(mapOnlyMap);

    const setupClusters = readFileSync(join(repoViaSetup, ".octograph", "clusters.json"), "utf8");
    const mapOnlyClusters = readFileSync(join(repoViaMapOnly, ".octograph", "clusters.json"), "utf8");
    // Deep-equal on the parsed document, not byte-equal on the text: both
    // are written by the SAME `writeArtifact` (artifact.ts) with the same
    // deterministic key order, so this is not weakening the assertion —
    // it is what lets the failure message show which key actually
    // disagreed instead of a raw two-file text diff.
    expect(JSON.parse(setupClusters)).toEqual(JSON.parse(mapOnlyClusters));

    // NON-VACUITY, asserted rather than asserted-in-a-comment. Two empty
    // documents are equal too, and the previous fixture (every file at the
    // repo root, one declared module) produced exactly that: one module row,
    // an empty coupling section, a single cluster. What is compared above
    // has to be a map with real structure in it, or the equality proves
    // nothing about the build.
    const moduleRows = setupMap.split("\n").filter((l) => /^- \*\*/.test(l));
    expect(moduleRows.length).toBeGreaterThanOrEqual(3);
    const couplingRows = setupMap.split("\n").filter((l) => l.includes(" ↔ "));
    expect(couplingRows.length).toBeGreaterThanOrEqual(2);
    expect(setupMap).toContain("## Working sets");
    const clusters = JSON.parse(setupClusters) as { clusters: Record<string, string[]> };
    expect(Object.keys(clusters.clusters).length).toBeGreaterThanOrEqual(2);

    expect(trackedSnapshot(repoViaSetup)).toBe(snapshotBefore);
    expect(trackedStatus(repoViaSetup)).toBe(statusBefore);
  });
});

describe("the graphifyy package name is pinned, not a typo", () => {
  /**
   * Criterion 6: the install command's package name (`graphifyy`, double-y)
   * must be pinned by a test whose failure message explains WHY, so a
   * well-meaning future edit that "corrects" it to `graphify` (the
   * `Graphify-Labs/graphify` GitHub repo's own name, single-y) fails loudly
   * instead of shipping silently. `setup.test.ts` already asserts the argv
   * shape via a fake port's recorded calls; this is a second, source-level
   * pin — modelled on `conventions.test.ts`'s own guards — so the two
   * cannot both be edited to agree on the wrong spelling without a reviewer
   * seeing this message.
   */
  it("src/setup.ts's INSTALL_ARGV names the published package `graphifyy`, never the `graphify` repo name", () => {
    const source = readFileSync(join(SRC_DIR, "setup.ts"), "utf8");
    expect(
      source,
      "octograph installs the PUBLISHED package `graphifyy` (double-y) via " +
        "`uv tool install graphifyy` — NOT `graphify` (the Graphify-Labs/graphify GitHub " +
        "repo's own name, single-y). If this assertion just failed because someone " +
        "'fixed' the spelling to `graphify`, revert it: the double-y is deliberate " +
        "(see setup.ts's own INSTALL_ARGV comment), not a typo, and this is not a bug.",
    ).toMatch(/"tool",\s*"install",\s*"graphifyy"/);
  });

  it("the real bin's install prompt offers the same pinned spelling, driven end to end with a declined install", () => {
    const bundle = buildBundle();
    const repo = e2eRepo();
    const decoy = decoys(["uv"]);

    const result = withPath(controlledPath(decoy.dir), () =>
      runNode([bundle, "setup"], repo, { input: "n\n" }),
    );

    expect(
      result.stdout,
      "the live install prompt must offer `uv tool install graphifyy` verbatim — if this " +
        "just changed to `graphify`, it is a regression, not a correction",
    ).toContain("uv tool install graphifyy");
  });
});
