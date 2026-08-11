import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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

/**
 * The absolute directory a real executable resolves to on THIS machine's
 * real, unmodified `PATH` — read once, before any scenario below starts
 * overriding `process.env.PATH`. `node`'s own directory comes straight off
 * `process.execPath`; every other lookup (`git`) goes through `which`/
 * `where`, the same primitive `setup-io.ts`'s real `which()` uses.
 */
function resolveBinDir(bin: string): string {
  const lookup = process.platform === "win32" ? "where" : "which";
  const out = execFileSync(lookup, [bin]).toString();
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
 * Refuses to run a scenario if `uv` (or, on Windows, `uv.exe`) actually lives
 * in one of the directories a scenario is about to put on the child's
 * `PATH`. Every scenario below builds its `PATH` from exactly `NODE_DIR` and
 * `GIT_DIR` (plus, for the consent-refusal scenario, a throwaway decoy
 * directory this file controls) — never the real, ambient `PATH` — precisely
 * so `uv`'s presence or absence on the developer's own machine cannot decide
 * whether these scenarios are testing what they claim to. This is the
 * backstop for the one way that could still go wrong: a machine where the
 * package manager that installed `node` or `git` also dropped `uv` into the
 * SAME directory (verified NOT the case in a real Homebrew/nvm layout, but
 * asserted here rather than assumed).
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

/**
 * A throwaway executable named `uv` that PROVES, rather than merely being
 * absent, whether it was ever actually run: `which`/`where` sees it on
 * `PATH` (so a scenario that declines the install still exercises the real
 * "is uv here?" lookup), but its body only writes `sentinel` if the shell
 * actually executes it — which `runSetup` must never do without consent.
 * POSIX only (`#!/bin/sh`), matching this suite's CI (`ubuntu-latest`).
 */
function decoyUv(): { dir: string; sentinel: string } {
  const dir = mkdtempClean("octograph-decoy-uv-");
  const sentinel = join(dir, "spawned.marker");
  const scriptPath = join(dir, "uv");
  writeFileSync(scriptPath, `#!/bin/sh\necho spawned >> "${sentinel}"\nexit 0\n`);
  chmodSync(scriptPath, 0o755);
  return { dir, sentinel };
}

/** History deep enough that, combined with `octograph.yaml`'s `minCommits`
 *  override below, `historyIsThin` never fires — the same shape
 *  `setup.test.ts`'s `healthyRepo` uses, kept small so this suite stays
 *  fast. */
const COMMITS: CommitSpec[] = Array.from({ length: 8 }, (_, i) => ({
  files: [`a${i}.ts`, `b${i}.ts`],
}));

/**
 * A fixture repo with real git history AND a committed `octograph.yaml`
 * overriding `minCommits` — the real bin loads config off disk
 * (`loadConfig(repoRoot)` in `bin/octograph.mjs`), unlike the unit-level
 * `setup.test.ts`, which hands `runSetup` an in-memory `Config` override
 * directly. The config commit touches exactly one file, which `harvest`
 * drops outright (`files.length < 2`) — it does not count toward
 * `analysable`, exactly like `e2e-gate.test.ts`'s own `.gitignore` commit.
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

/** TRACKED paths only, in the git-decided order — same primitive
 *  `setup.test.ts`'s own `trackedFiles`/`trackedStatus` use, re-typed here
 *  rather than imported: this file's fixtures are real subprocess-driven
 *  repos, not the in-process `runSetup` calls that suite drives. */
function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter((f) => f !== "");
}

function trackedStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
  }).toString();
}

describe("end-to-end: octograph setup, driven as a real subprocess with scripted stdin", () => {
  it("answering NO to the install prompt: no install runs, and the exit code and postflight are correct", () => {
    const bundle = buildBundle();
    const repo = e2eRepo();
    const { dir: decoyDir, sentinel } = decoyUv();
    assertNoRealUv([NODE_DIR, GIT_DIR]);
    const controlledPath = [NODE_DIR, GIT_DIR, decoyDir].join(delimiter);

    const filesBefore = trackedFiles(repo);
    const statusBefore = trackedStatus(repo);
    expect(statusBefore).toBe(""); // sanity: the fixture starts clean

    const result = withPath(controlledPath, () =>
      runNode([bundle, "setup"], repo, { input: "n\n" }),
    );

    // The decoy `uv` is ON PATH (so the prompt fires at all — `which("uv")`
    // succeeds), but its body never ran: nothing was installed.
    expect(existsSync(sentinel)).toBe(false);
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
    expect(trackedFiles(repo)).toEqual(filesBefore);
    expect(trackedStatus(repo)).toBe(statusBefore);
  });

  it("with uv absent from PATH, the install URL is printed, the prompt never fires, and nothing is spawned", () => {
    const bundle = buildBundle();
    const repo = e2eRepo();
    assertNoRealUv([NODE_DIR, GIT_DIR]);
    // No decoy this time — `uv` is not anywhere on this PATH, full stop.
    const controlledPath = [NODE_DIR, GIT_DIR].join(delimiter);

    const filesBefore = trackedFiles(repo);
    const statusBefore = trackedStatus(repo);

    // Scripted "yes" on purpose: proves the absence check runs BEFORE the
    // prompt, per `setup.ts`'s own ordering. If that ever regressed to
    // prompt-first, this "yes" would need `uv` to install something, and
    // there is none on this PATH to do it — the run would hang on stdin
    // instead of exiting, and this test would time out rather than pass by
    // accident.
    const result = withPath(controlledPath, () =>
      runNode([bundle, "setup"], repo, { input: "y\n" }),
    );

    expect(result.stdout).toContain(
      "octograph: `uv` not found on PATH — install it yourself from " +
        "https://docs.astral.sh/uv/getting-started/installation/",
    );
    // The prompt text never appears — it was never reached.
    expect(result.stdout).not.toContain("Install Graphify now via");
    expect(result.code).toBe(1);

    expect(trackedFiles(repo)).toEqual(filesBefore);
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

      const { dir: decoyDir, sentinel } = decoyUv();
      assertNoRealUv([NODE_DIR, GIT_DIR]);
      const controlledPath = [NODE_DIR, GIT_DIR, decoyDir].join(delimiter);

      const filesBefore = trackedFiles(repo);
      const statusBefore = trackedStatus(repo);

      const result = withPath(controlledPath, () =>
        runNode([isolated, "setup"], repo, { input: "n\n" }),
      );

      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout).toContain("octograph: setup finished — final state:");
      expect(result.code).toBe(0);
      expect(existsSync(sentinel)).toBe(false);

      expect(trackedFiles(repo)).toEqual(filesBefore);
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
   * Driven through `runSetup` directly with a FAKE port — never the real
   * bin with a scripted "y" — because a real bin run with consent would
   * reach `setup-io.ts`'s real `exec()` and actually invoke
   * `uv tool install graphifyy`, which this suite must never do. The fake's
   * `exec()` is a no-op (mirrors what a real `uv tool install` does to
   * THIS repo: nothing — it installs an executable onto the user's
   * machine, not a file into the fixture), so both repos reach `analyze()`
   * with identical inputs: no `graphify-out/graph.json` on either side.
   */
  it("a full-consent runSetup produces map.md and clusters.json equal to what `map` alone produces on an identical repo at the same now", async () => {
    function twin(): string {
      const repo = buildRepo(COMMITS);
      writeFileSync(join(repo, "octograph.yaml"), "minCommits: 5\n");
      execFileSync("git", ["add", "octograph.yaml"], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["commit", "-q", "-m", "chore: configure octograph for the fixture"], {
        cwd: repo,
        stdio: "pipe",
      });
      return repo;
    }

    const repoViaSetup = twin();
    const repoViaMapOnly = twin();

    const filesBefore = trackedFiles(repoViaSetup);
    const statusBefore = trackedStatus(repoViaSetup);

    const io: SetupIO = {
      prompt: async () => true,
      log: () => {
        /* not under test here — the other two tests in this file assert
         * on the real bin's postflight text */
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

    // Non-vacuity: the comparison actually ran over a non-trivial map.
    expect(setupMap).toContain("## Modules");

    expect(trackedFiles(repoViaSetup)).toEqual(filesBefore);
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
    const { dir: decoyDir } = decoyUv();
    assertNoRealUv([NODE_DIR, GIT_DIR]);
    const controlledPath = [NODE_DIR, GIT_DIR, decoyDir].join(delimiter);

    const result = withPath(controlledPath, () =>
      runNode([bundle, "setup"], repo, { input: "n\n" }),
    );

    expect(
      result.stdout,
      "the live install prompt must offer `uv tool install graphifyy` verbatim — if this " +
        "just changed to `graphify`, it is a regression, not a correction",
    ).toContain("uv tool install graphifyy");
  });
});
