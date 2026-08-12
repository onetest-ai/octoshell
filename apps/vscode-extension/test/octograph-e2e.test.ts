// The mission's own end-to-end gate (T6.5): a workspace with no graph, a stale one, and proof the
// two-command launcher never grows beyond "open a terminal, send a string, show it". Everything
// below drives the REAL exported functions against REAL fixture workspaces and, where the plan
// says "executes"/"writes", actually runs the shipped bundle under bare `node` — not a mock of the
// bundle, and not a re-derivation of a rule another module already owns (see the `artifactPath`
// and `GRAPH_RELATIVE_PATH` uses throughout: this file reads those exported answers rather than
// re-computing the `.octobots/graph` vs `.octograph` fallback, or the installed-payload path, a
// second time).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { launchInstallGraph, launchRebuildGraph } from "../src/host/octograph-command.js";
import { GRAPH_RELATIVE_PATH, graphStatus, installGraph } from "../src/host/octograph-install.js";
import { artifactPath, graphCommand } from "../src/host/octograph.js";
import { OCTOBOTS_PACK_VERSION, installPack, packStatus } from "../src/host/octobots-skill.js";
import { TERMINAL_EVENTS } from "./fixtures/terminal-events.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** The extension's own shipped pack resources — the real payload these tests install and run. */
const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

const HOST_DIR = join(__dirname, "..", "src", "host");

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

/**
 * A throwaway git repo with real, timestamped history — every fixture in this file is created
 * through `mkdtempClean`, so it is removed on completion whether the test passes or throws (see
 * `test/fixtures/tmpdir.ts`; NEVER a bare `mkdtempSync` here — that leaks the repo, and its `.git`
 * object database, on every run).
 *
 * `commits` is small on purpose: this suite verifies the bundle EXECUTES and WRITES real files
 * under bare `node`, not that the fixture repo itself clears octograph's own "history depth"
 * health check (that wants ~200 commits and is irrelevant to what this suite checks — a
 * "degraded" doctor verdict on a thin fixture is an expected, correct answer, not a test failure).
 */
function gitRepo(prefix: string, commits = 3): string {
  const root = mkdtempClean(prefix);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "qa@example.com"]);
  git(root, ["config", "user.name", "QA"]);
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(root, "a.ts"), `export const a = ${i};\n`);
    writeFileSync(join(root, "b.ts"), `export const b = ${i};\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", `commit ${i}`]);
  }
  return root;
}

/**
 * Actually run a launcher-produced command string — the exact text `octograph-command.ts` hands
 * `terminal.sendText`, executed for real through a shell, the way a VS Code integrated terminal
 * would. `input: ""` closes stdin immediately, so `octograph setup`'s y/N prompt resolves to "no"
 * rather than hanging (see `packages/graph/src/setup-io.ts`'s `prompt`: EOF is not consent, and
 * settles the same way a bare Enter does). Never throws on a non-zero exit — a "degraded" doctor
 * verdict is an expected outcome on these fixtures, not a spawn failure.
 */
function runLauncherCommand(
  command: string,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => vi.restoreAllMocks());

describe("T6.5/Step 1 — Install Graph on a workspace with the pack but no octograph", () => {
  it("lands the bundle at the documented path and it runs under bare node with no node_modules", () => {
    const repo = gitRepo("octograph-e2e-install-");
    installPack(PACK_SRC, repo);
    expect(packStatus(repo).installed).toBe(true);
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION).present).toBe(false); // no octograph yet

    const t = { sendText: vi.fn(), show: vi.fn() };
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);

    launchInstallGraph(PACK_SRC, repo);

    // Lands at the documented path — read through the exported constant, not a hand-typed string.
    const installedPath = join(repo, GRAPH_RELATIVE_PATH);
    expect(existsSync(installedPath)).toBe(true);
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
    expect(t.sendText).toHaveBeenCalledWith(graphCommand("setup"));

    // "Executes under bare node with no node_modules" is an observable claim, not a source-reading
    // one: this fixture lives under the OS temp dir (via mkdtempClean), entirely outside this
    // monorepo's own node_modules tree, and nothing here installs one into it. The proof is that
    // the exact string the launcher sent really runs there and produces real output — a
    // `Cannot find module` / `ERR_MODULE_NOT_FOUND` would mean the "no node_modules" claim is false.
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
    const sentCommand = t.sendText.mock.calls[0]?.[0] as string;
    const result = runLauncherCommand(sentCommand, repo);
    expect(result.stderr).not.toMatch(/cannot find module|err_module_not_found|command not found/i);
    expect(result.stdout).toMatch(/octograph/i);

    // It really ran the map pipeline as part of `setup` — through the exported artifactPath(),
    // never a re-derived .octobots-vs-.octograph guess.
    const outDir = artifactPath(repo);
    expect(existsSync(join(outDir, "map.md"))).toBe(true);
    expect(existsSync(join(outDir, "clusters.json"))).toBe(true);
  }, 30_000);
});

describe("T6.5/Step 2 — a stale installed bundle: the drift prompt fires, re-install is byte-identical", () => {
  it("packStatus flips to not-up-to-date, and re-installing via the real launcher reproduces the shipped payload exactly", () => {
    const repo = gitRepo("octograph-e2e-stale-");
    installPack(PACK_SRC, repo);
    installGraph(PACK_SRC, repo); // workspace already has graph installed, at the current version

    // Simulate what a stale installed copy looks like after an extension upgrade: the marker names
    // an older pack version and the body differs from what's shipped now.
    const entry = join(repo, GRAPH_RELATIVE_PATH);
    writeFileSync(entry, `// octobots-pack-version: ${OCTOBOTS_PACK_VERSION - 1}\nold body\n`);

    // "The drift prompt fires" IS `activate()`'s own gating condition (`src/extension.ts`:
    // `if (st.installed && st.upToDate) return;` — anything else shows the Install/Update prompt).
    // Asked here through the same `packStatus` that condition reads, not a second computation of it.
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: false });
    expect(packStatus(repo).upToDate).toBe(false);

    // Re-install: what a user clicking "Install" in response to that prompt triggers — through the
    // real command, not a raw installGraph() call.
    const t = { sendText: vi.fn(), show: vi.fn() };
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);
    launchInstallGraph(PACK_SRC, repo);

    const shipped = readFileSync(join(PACK_SRC, "graph", "octograph.mjs"));
    expect(readFileSync(entry)).toEqual(shipped); // byte-identical to the new payload
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
    expect(packStatus(repo).upToDate).toBe(true); // the prompt would no longer fire
  });
});

describe("T6.5/Step 3 — Rebuild Graph against a real workspace writes at the resolved artifactPath()", () => {
  it("writes map.md and clusters.json exactly where artifactPath() says, for a workspace with a board", () => {
    const repo = gitRepo("octograph-e2e-rebuild-");
    mkdirSync(join(repo, ".octobots"), { recursive: true }); // this workspace has a board
    installGraph(PACK_SRC, repo);

    const t = { sendText: vi.fn(), show: vi.fn() };
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);
    launchRebuildGraph(repo);

    expect(t.sendText).toHaveBeenCalledWith(graphCommand("map"));
    const sentCommand = t.sendText.mock.calls[0]?.[0] as string;

    const result = runLauncherCommand(sentCommand, repo);
    expect(result.stderr).not.toMatch(/cannot find module|err_module_not_found/i);
    expect(result.status).toBe(0);

    // The location under test is whatever artifactPath() RETURNS — never a hand-built
    // `.octobots/graph` string re-deriving the same branch that function already owns.
    const outDir = artifactPath(repo);
    expect(existsSync(join(outDir, "map.md"))).toBe(true);
    expect(existsSync(join(outDir, "clusters.json"))).toBe(true);
  }, 30_000);

  it("writes at artifactPath() for a workspace with NO board too (the other branch)", () => {
    const repo = gitRepo("octograph-e2e-rebuild-noboard-");
    installGraph(PACK_SRC, repo);

    const t = { sendText: vi.fn(), show: vi.fn() };
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);
    launchRebuildGraph(repo);

    const sentCommand = t.sendText.mock.calls[0]?.[0] as string;
    // Asserted on BOTH branches, not just the board one: a `map` that exited non-zero and left a
    // stale artifact behind would satisfy the existence checks below on their own.
    const result = runLauncherCommand(sentCommand, repo);
    expect(result.stderr).not.toMatch(/cannot find module|err_module_not_found/i);
    expect(result.status).toBe(0);

    const outDir = artifactPath(repo);
    expect(existsSync(join(outDir, "map.md"))).toBe(true);
    expect(existsSync(join(outDir, "clusters.json"))).toBe(true);
  }, 30_000);
});

describe("T6.5/Step 4 — the launcher stays thin: grepped, not reviewed", () => {
  /**
   * Strip `/* ... *\/` and `// ...` before matching. This codebase's own convention is to NAME a
   * forbidden pattern inside a doc comment as a warning (`octograph-command.ts`'s header literally
   * quotes `writeFileSync` and `terminal.exitStatus` as examples of a violation a PRIOR, weaker
   * test let through) — a raw substring grep would flag that prose as the violation it is
   * documenting against. Exact here, not a heuristic: the precondition test below pins the one
   * thing that would make a line-based strip LOSE code — a `//` sitting inside a string literal,
   * after which the strip would delete real code to the end of that line and hide a violation.
   */
  function stripBlockComments(source: string): string {
    // Newlines preserved, so line numbers still mean something to the precondition test below and
    // so `^(?:let|var)` keeps meaning "at the start of a line" rather than "wherever a removed doc
    // comment happened to leave the cursor".
    return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  }

  function codeOnly(source: string): string {
    return stripBlockComments(source).replace(/\/\/.*$/gm, "");
  }

  /**
   * The forbidden-pattern set, as ONE list of cases: every rule carries the `sample` that must
   * trip it. The meta-tests below run that sample through the whole set, so a rule whose regex is
   * typo'd, or silently made unmatchable, fails BY ID instead of sitting in the array looking
   * enforced. The previous shape asserted only that *some* rule fired on one hand-written snippet
   * — 30 dead patterns would have passed it.
   *
   * The categories are the four properties the mission forbids, not three: "state tracking" and
   * "post-run verification" are here because planting them proved both gates blind to them
   * (verified 2026-08-11 — a module-scope `let lastRun` plus a `setTimeout` that reported the run
   * afterwards passed BOTH this suite and `octograph-command.test.ts` green; the behavioural gate
   * cannot see either, because neither touches the terminal or the workspace's file tree).
   */
  type Category =
    | "output capture"
    | "terminal event registrar"
    | "state write"
    | "state tracking"
    | "post-run verification";

  interface Rule {
    readonly id: string;
    readonly category: Category;
    readonly pattern: RegExp;
    readonly sample: string;
  }

  const RULES: readonly Rule[] = [
    // Output capture — reading back what the terminal or a spawned process produced.
    { id: "exitStatus", category: "output capture", pattern: /\.exitStatus\b/, sample: "const x = terminal.exitStatus;" },
    { id: "processId", category: "output capture", pattern: /\.processId\b/, sample: "void terminal.processId;" },
    { id: "shellIntegration", category: "output capture", pattern: /shellIntegration/, sample: "terminal.shellIntegration?.executeCommand(a);" },
    { id: "stdout", category: "output capture", pattern: /\.stdout\b/, sample: "const o = result.stdout;" },
    { id: "stderr", category: "output capture", pattern: /\.stderr\b/, sample: "const e = result.stderr;" },
    { id: "execFile", category: "output capture", pattern: /\bexecFile(?:Sync)?\s*\(/, sample: "execFileSync('node', []);" },
    { id: "exec", category: "output capture", pattern: /\bexec(?:Sync)?\s*\(/, sample: "execSync('node');" },
    { id: "spawn", category: "output capture", pattern: /\bspawn(?:Sync)?\s*\(/, sample: "spawnSync('node', []);" },
    { id: "child_process", category: "output capture", pattern: /child_process/, sample: 'import { exec } from "node:child_process";' },
    // Terminal lifecycle registrars — the SHARED list, so this half of the gate and
    // `octograph-command.test.ts`'s behavioural half can never cover different registrars.
    ...TERMINAL_EVENTS.map(
      (name): Rule => ({
        id: `window.${name}`,
        category: "terminal event registrar",
        pattern: new RegExp(`\\b${name}\\b`),
        sample: `vscode.window.${name}(() => {});`,
      }),
    ),
    { id: "process.on", category: "terminal event registrar", pattern: /process\.on\s*\(/, sample: "process.on('exit', () => {});" },
    { id: "on-exit-close", category: "terminal event registrar", pattern: /\.on\s*\(\s*["'](exit|close)["']/, sample: "child.on('close', () => {});" },
    // State writes — anything that changes what is on disk.
    { id: "writeFileSync", category: "state write", pattern: /writeFileSync\s*\(/, sample: 'writeFileSync("x", "y");' },
    { id: "writeFile", category: "state write", pattern: /\bwriteFile\s*\(/, sample: 'await writeFile("x", "y");' },
    { id: "appendFileSync", category: "state write", pattern: /appendFileSync\s*\(/, sample: 'appendFileSync("x", "y");' },
    { id: "appendFile", category: "state write", pattern: /\bappendFile\s*\(/, sample: 'await appendFile("x", "y");' },
    { id: "mkdirSync", category: "state write", pattern: /mkdirSync\s*\(/, sample: 'mkdirSync("x");' },
    { id: "renameSync", category: "state write", pattern: /renameSync\s*\(/, sample: 'renameSync("a", "b");' },
    { id: "rmSync", category: "state write", pattern: /rmSync\s*\(/, sample: 'rmSync("x");' },
    { id: "copyFileSync", category: "state write", pattern: /copyFileSync\s*\(/, sample: 'copyFileSync("a", "b");' },
    { id: "createWriteStream", category: "state write", pattern: /createWriteStream\s*\(/, sample: 'createWriteStream("x");' },
    { id: "fs.promises", category: "state write", pattern: /fs\.promises\./, sample: 'await fs.promises.writeFile("x", "y");' },
    // State tracking — remembering that a run happened, in memory or in VS Code's own stores.
    // These leave the workspace file tree untouched, which is exactly why the tree-snapshot gate
    // in `octograph-command.test.ts` cannot see them.
    { id: "module-scope-let", category: "state tracking", pattern: /^(?:let|var)\s/m, sample: "let lastRun: number | undefined;" },
    { id: "globalState", category: "state tracking", pattern: /globalState/, sample: 'context.globalState.update("lastRun", 1);' },
    { id: "workspaceState", category: "state tracking", pattern: /workspaceState/, sample: 'context.workspaceState.update("lastRun", 1);' },
    { id: "Memento", category: "state tracking", pattern: /\bMemento\b/, sample: "function f(m: vscode.Memento): void {}" },
    { id: "setContext", category: "state tracking", pattern: /["']setContext["']/, sample: 'void vscode.commands.executeCommand("setContext", "x", true);' },
    // Post-run verification — coming back later to judge whether the run worked. `doctor`, inside
    // the terminal, is what judges that; the launcher opens the terminal and stops.
    { id: "setTimeout", category: "post-run verification", pattern: /\bsetTimeout\s*\(/, sample: "setTimeout(() => check(), 5000);" },
    { id: "setInterval", category: "post-run verification", pattern: /\bsetInterval\s*\(/, sample: "setInterval(() => check(), 500);" },
    { id: "nextTick", category: "post-run verification", pattern: /process\.nextTick\s*\(/, sample: "process.nextTick(() => check());" },
    { id: "queueMicrotask", category: "post-run verification", pattern: /\bqueueMicrotask\s*\(/, sample: "queueMicrotask(() => check());" },
    { id: "watchFile", category: "post-run verification", pattern: /\bwatch(?:File)?\s*\(/, sample: 'watch(outDir, () => check());' },
  ];

  /**
   * Which categories a module is excused from, and why. Per-CATEGORY, never per-file: exempting a
   * whole module would have silently excused `octograph-install.ts` from the output-capture,
   * registrar and post-run-verification rules it has no business breaking either.
   */
  const EXEMPTIONS: Readonly<Record<string, readonly Category[]>> = {
    // The payload copy IS a state write, and it is the command's whole point — the ONE write in
    // this mission, gated on the user explicitly invoking "Octobots: Install Graph"
    // (`octograph-command.ts`). Every other category still applies to it.
    "octograph-install.ts": ["state write"],
  };

  /**
   * The modules under test, DISCOVERED rather than hand-listed. A hand-typed pair is exactly the
   * shape of guard this mission's brief warns about: dropping a new `src/host/octograph-run.ts`
   * carrying a `writeFileSync` and an `onDidCloseTerminal` registration next to the two named
   * files left the whole suite green (verified 2026-08-11, by planting that file). Discovery makes
   * a new octograph host module scanned the moment it exists.
   */
  function octographHostModules(): string[] {
    return readdirSync(HOST_DIR)
      .filter((f) => /^octograph.*\.ts$/.test(f))
      .sort();
  }

  function violations(source: string, exempt: readonly Category[] = []): string[] {
    const stripped = codeOnly(source);
    return RULES.filter((r) => !exempt.includes(r.category) && r.pattern.test(stripped)).map(
      (r) => `${r.category}: ${r.id}`,
    );
  }

  it("meta: every rule matches its own sample, so a dead pattern fails by id instead of hiding", () => {
    const dead = RULES.filter((r) => !r.pattern.test(codeOnly(r.sample))).map((r) => r.id);
    expect(dead).toEqual([]);
  });

  it("meta: rule ids are unique, so a hit names exactly one rule", () => {
    const ids = RULES.map((r) => r.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("meta: every sample IS caught by the full set (the guard is not vacuously green)", () => {
    for (const rule of RULES) {
      expect({ id: rule.id, hits: violations(rule.sample) }).toEqual({
        id: rule.id,
        hits: expect.arrayContaining([`${rule.category}: ${rule.id}`]),
      });
    }
  });

  it("meta: no sample is flagged when it appears only inside a comment", () => {
    for (const rule of RULES) {
      expect({ id: rule.id, hits: violations(`// ${rule.sample}\n`) }).toEqual({ id: rule.id, hits: [] });
      expect({ id: rule.id, hits: violations(`/**\n * ${rule.sample}\n */\n`) }).toEqual({ id: rule.id, hits: [] });
    }
  });

  it("precondition: no host module puts `//` inside a string literal, so the comment strip loses no code", () => {
    for (const name of octographHostModules()) {
      // Block comments blanked first (line numbers preserved): a backtick or quote inside prose is
      // not a string literal, and `octograph-install.ts`'s doc comment legitimately writes
      // "the `// octobots-pack-version: N` marker".
      const lines = stripBlockComments(readFileSync(join(HOST_DIR, name), "utf8")).split("\n");
      for (const [i, line] of lines.entries()) {
        const at = line.indexOf("//");
        if (at < 0) continue;
        // A quote before the `//` on the same line is the only way `//` is NOT a comment start;
        // the strip would then delete real code after it. Reported with the line so a future
        // violation is a one-line fix, not a mystery.
        expect({ file: name, line: i + 1, quotedBefore: /["'`]/.test(line.slice(0, at)) }).toEqual({
          file: name,
          line: i + 1,
          quotedBefore: false,
        });
      }
    }
  });

  it("meta: every module named in EXEMPTIONS still exists, and the launcher modules are discovered", () => {
    const modules = octographHostModules();
    expect(modules).toEqual(expect.arrayContaining(["octograph.ts", "octograph-command.ts", "octograph-install.ts"]));
    for (const name of Object.keys(EXEMPTIONS)) expect(modules).toContain(name);
  });

  it("no octograph host module captures output, registers a terminal event, tracks run state, or verifies after the fact", () => {
    const found = octographHostModules().map((name) => ({
      name,
      hits: violations(readFileSync(join(HOST_DIR, name), "utf8"), EXEMPTIONS[name] ?? []),
    }));
    expect(found).toEqual(octographHostModules().map((name) => ({ name, hits: [] })));
  });

  it("sanity: the comment strip leaves the real code of both launcher modules intact", () => {
    expect(codeOnly(readFileSync(join(HOST_DIR, "octograph.ts"), "utf8"))).toMatch(
      /export function graphCommand/,
    );
    expect(codeOnly(readFileSync(join(HOST_DIR, "octograph-command.ts"), "utf8"))).toMatch(
      /terminal\.sendText\(graphCommand\(/,
    );
  });
});

describe("T6.5/Step 5 — no @octoshell/graph runtime dependency, and the built bundle carries none of its source", () => {
  it("apps/vscode-extension/package.json declares no @octoshell/graph runtime dependency", () => {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@octoshell/graph");
  });

  it("bundling the extension host (the same entry esbuild.mjs uses) pulls in none of packages/graph's source", async () => {
    const result = await build({
      entryPoints: [join(__dirname, "..", "src", "extension.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["vscode"],
      write: false,
      logLevel: "silent",
    });
    const file = result.outputFiles[0];
    if (!file) throw new Error("esbuild produced no output for the extension host bundle");
    const text = Buffer.from(file.contents).toString("utf8");

    // Markers that exist ONLY inside packages/graph's own implementation — never legitimately
    // reachable from the extension's TypeScript (mission criterion 4) — distinct from filenames
    // like `octograph.yaml` or `map.md` the extension's own host modules legitimately mention in
    // prose (those survive fine; they are not this package's SOURCE leaking in).
    const GRAPH_SOURCE_MARKERS = ["graphifyy", "uv tool install", "GRAPHIFY_BIN", "clustersToMap"];
    for (const marker of GRAPH_SOURCE_MARKERS) {
      expect(text).not.toContain(marker);
    }
  }, 60_000);
});
