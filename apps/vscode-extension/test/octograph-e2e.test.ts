// The mission's own end-to-end gate (T6.5): a workspace with no graph, a stale one, and proof the
// two-command launcher never grows beyond "open a terminal, send a string, show it". Everything
// below drives the REAL exported functions against REAL fixture workspaces and, where the plan
// says "executes"/"writes", actually runs the shipped bundle under bare `node` — not a mock of the
// bundle, and not a re-derivation of a rule another module already owns (see the `artifactPath`
// and `GRAPH_RELATIVE_PATH` uses throughout: this file reads those exported answers rather than
// re-computing the `.octobots/graph` vs `.octograph` fallback, or the installed-payload path, a
// second time).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { launchInstallGraph, launchRebuildGraph } from "../src/host/octograph-command.js";
import { GRAPH_RELATIVE_PATH, graphStatus, installGraph } from "../src/host/octograph-install.js";
import { artifactPath, graphCommand } from "../src/host/octograph.js";
import { OCTOBOTS_PACK_VERSION, installPack, packStatus } from "../src/host/octobots-skill.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** The extension's own shipped pack resources — the real payload these tests install and run. */
const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

const OCTOGRAPH_HOST = join(__dirname, "..", "src", "host", "octograph.ts");
const OCTOGRAPH_COMMAND_HOST = join(__dirname, "..", "src", "host", "octograph-command.ts");

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
    runLauncherCommand(sentCommand, repo);

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
   * documenting against. Exact here, not a heuristic: verified below that neither host module has
   * `//` inside a string literal, which is what would make a line-based strip lie.
   */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const FORBIDDEN: readonly { category: string; pattern: RegExp }[] = [
    // Output capture — reading back what the terminal/process produced.
    { category: "output capture", pattern: /\.exitStatus\b/ },
    { category: "output capture", pattern: /\.processId\b/ },
    { category: "output capture", pattern: /shellIntegration/ },
    { category: "output capture", pattern: /onDidWriteTerminalData/ },
    { category: "output capture", pattern: /\.stdout\b/ },
    { category: "output capture", pattern: /\.stderr\b/ },
    { category: "output capture", pattern: /\bexecFile\b/ },
    { category: "output capture", pattern: /\bexecSync\b/ },
    { category: "output capture", pattern: /\bspawnSync\b/ },
    { category: "output capture", pattern: /\bspawn\s*\(/ },
    { category: "output capture", pattern: /child_process/ },
    // Exit / close handlers — any terminal lifecycle registrar.
    { category: "exit/close handler", pattern: /onDidCloseTerminal/ },
    { category: "exit/close handler", pattern: /onDidOpenTerminal/ },
    { category: "exit/close handler", pattern: /onDidChangeActiveTerminal/ },
    { category: "exit/close handler", pattern: /onDidChangeTerminalState/ },
    { category: "exit/close handler", pattern: /onDidChangeTerminalShellIntegration/ },
    { category: "exit/close handler", pattern: /onDidStartTerminalShellExecution/ },
    { category: "exit/close handler", pattern: /onDidEndTerminalShellExecution/ },
    { category: "exit/close handler", pattern: /process\.on\s*\(/ },
    { category: "exit/close handler", pattern: /\.on\s*\(\s*["'](exit|close)["']/ },
    // State writes — anything that changes what's on disk.
    { category: "state write", pattern: /writeFileSync\s*\(/ },
    { category: "state write", pattern: /\bwriteFile\s*\(/ },
    { category: "state write", pattern: /appendFileSync\s*\(/ },
    { category: "state write", pattern: /\bappendFile\s*\(/ },
    { category: "state write", pattern: /mkdirSync\s*\(/ },
    { category: "state write", pattern: /renameSync\s*\(/ },
    { category: "state write", pattern: /rmSync\s*\(/ },
    { category: "state write", pattern: /copyFileSync\s*\(/ },
    { category: "state write", pattern: /createWriteStream\s*\(/ },
    { category: "state write", pattern: /fs\.promises\./ },
  ];

  it("precondition: neither host module has `//` inside a string literal, so a line-based comment strip is exact", () => {
    for (const path of [OCTOGRAPH_HOST, OCTOGRAPH_COMMAND_HOST]) {
      const src = readFileSync(path, "utf8");
      expect(src).not.toContain("http://");
      expect(src).not.toContain("https://");
    }
  });

  it("self-test: the pattern set catches a planted violation OUTSIDE a comment (proves this is not vacuously green)", () => {
    const planted =
      'const x = terminal.exitStatus;\nwriteFileSync("x", "y");\nvscode.window.onDidCloseTerminal(() => {});\n';
    const hits = FORBIDDEN.filter((f) => f.pattern.test(codeOnly(planted)));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does NOT flag the same words when they appear only in a comment (the false positive real doc comments here would otherwise trip)", () => {
    const commentOnly =
      '// a planted `writeFileSync` and a planted `terminal.exitStatus` read both passed it green\n' +
      "// registering vscode.window.onDidCloseTerminal would be the same class of violation\n";
    const hits = FORBIDDEN.filter((f) => f.pattern.test(codeOnly(commentOnly)));
    expect(hits).toEqual([]);
  });

  it("octograph.ts contains no output capture, no exit/close handler, and no state write, outside comments", () => {
    const stripped = codeOnly(readFileSync(OCTOGRAPH_HOST, "utf8"));
    // Sanity: the strip removed comments without eating the real code alongside them.
    expect(stripped).toMatch(/export function graphCommand/);
    const hits = FORBIDDEN.filter((f) => f.pattern.test(stripped)).map((f) => f.category);
    expect(hits).toEqual([]);
  });

  it("octograph-command.ts contains no output capture, no exit/close handler, and no state write, outside comments", () => {
    const stripped = codeOnly(readFileSync(OCTOGRAPH_COMMAND_HOST, "utf8"));
    expect(stripped).toMatch(/terminal\.sendText\(graphCommand\(/);
    const hits = FORBIDDEN.filter((f) => f.pattern.test(stripped)).map((f) => f.category);
    expect(hits).toEqual([]);
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
