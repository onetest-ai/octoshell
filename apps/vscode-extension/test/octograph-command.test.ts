import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as vscode from "vscode";
import { launchInstallGraph, launchRebuildGraph } from "../src/host/octograph-command.js";
import { GRAPH_ENTRY, GRAPH_RELATIVE_PATH, graphStatus } from "../src/host/octograph-install.js";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { TERMINAL_EVENTS } from "./fixtures/terminal-events.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** The extension's own shipped pack resources — the real source these commands install from. */
const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

/**
 * A terminal that throws on ANY property access other than `sendText`/`show`.
 *
 * This is THE thin-launcher assertion, and it is a behavioural one. The first version of this file
 * handed the module a plain `{ sendText, show }` object and claimed in a comment that anything
 * else "throws not a function rather than silently passing". It does not: reading
 * `terminal.exitStatus` yields `undefined`, `terminal.processId` yields `undefined`, and both
 * planted violations passed the suite green (verified 2026-08-11, by planting them). A Proxy that
 * throws by NAME is what actually catches output capture, exit-status polling, or shell-
 * integration reads.
 *
 * Symbol lookups are let through so error formatting and engine internals do not fail the test
 * for reasons the module had nothing to do with.
 */
function strictTerminal(): {
  sendText: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  terminal: vscode.Terminal;
} {
  const sendText = vi.fn();
  const show = vi.fn();
  const target: Record<string | symbol, unknown> = { sendText, show };
  const terminal = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "sendText" || prop === "show") {
        return Reflect.get(t, prop);
      }
      throw new Error(`thin launcher must not touch terminal.${String(prop)}`);
    },
  }) as unknown as vscode.Terminal;
  return { sendText, show, terminal };
}

/**
 * Every registrar in the shared {@link TERMINAL_EVENTS} list, temporarily installed on the stub as
 * a function that throws BY NAME. Registering an exit/close handler is the one thin-launcher
 * violation the terminal Proxy above cannot see (it happens on `window`, not on the terminal), and
 * relying on the stub simply lacking the member is not a guard — the day another test adds
 * `onDidCloseTerminal` to `test/vscode-stub.ts`, that accident evaporates silently.
 *
 * The list itself is `test/fixtures/terminal-events.ts`, imported rather than re-typed:
 * `test/octograph-e2e.test.ts`'s source-text half of the same gate reads the SAME array, so a
 * registrar can never be covered by one suite and missed by the other.
 */
function trapTerminalEvents(): void {
  const win = vscode.window as unknown as Record<string, unknown>;
  for (const name of TERMINAL_EVENTS) {
    win[name] = () => {
      throw new Error(`thin launcher must not register vscode.window.${name}`);
    };
    onTestFinished(() => {
      delete win[name];
    });
  }
}

/** Every file under `root`, as `relative path → sha1`, so a write ANYWHERE shows up as a diff. */
function treeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        out.set(relative(root, p).split(sep).join("/"), createHash("sha1").update(readFileSync(p)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

/** Paths whose content differs between two snapshots (added, removed or rewritten). */
function treeDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [p, h] of after) if (before.get(p) !== h) changed.add(p);
  for (const p of before.keys()) if (!after.has(p)) changed.add(p);
  return [...changed].sort();
}

/** A pack-resources fixture carrying just the graph payload the commands install. */
function packFixture(body = "payload"): string {
  const src = mkdtempClean("octograph-packsrc-");
  mkdirSync(join(src, "graph"), { recursive: true });
  writeFileSync(join(src, "graph", GRAPH_ENTRY), `// octobots-pack-version: ${OCTOBOTS_PACK_VERSION}\n${body}`);
  return src;
}

function installBundle(repo: string): void {
  const dir = join(repo, ".claude", "skills", "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, GRAPH_ENTRY), `// octobots-pack-version: ${OCTOBOTS_PACK_VERSION}\nbody`);
}

afterEach(() => vi.restoreAllMocks());

describe("launchInstallGraph", () => {
  it("with no workspace folder: reports it, opens no terminal, installs nothing", () => {
    const src = packFixture();
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    launchInstallGraph(src, undefined);

    expect(err).toHaveBeenCalledOnce();
    expect(term).not.toHaveBeenCalled();
  });

  it("installs the payload, then creates a terminal cwd'd to the workspace, sends setup, shows it", () => {
    const src = packFixture();
    const repo = mkdtempClean("octograph-command-");
    const t = strictTerminal();
    trapTerminalEvents();
    const createTerminal = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t.terminal);

    launchInstallGraph(src, repo);

    // The install actually happened — this is what closes the loop Rebuild Graph points at.
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
    expect(readFileSync(join(repo, GRAPH_RELATIVE_PATH))).toEqual(
      readFileSync(join(src, "graph", GRAPH_ENTRY)),
    );
    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: repo }));
    expect(t.sendText).toHaveBeenCalledWith(`node ${GRAPH_RELATIVE_PATH} setup`);
    expect(t.show).toHaveBeenCalledOnce();
  });

  it("writes the payload and NOTHING else — no run state, no marker file", () => {
    const src = packFixture();
    const repo = mkdtempClean("octograph-command-");
    writeFileSync(join(repo, "pre-existing.txt"), "untouched");
    const t = strictTerminal();
    trapTerminalEvents();
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t.terminal);

    const before = treeSnapshot(repo);
    launchInstallGraph(src, repo);
    const after = treeSnapshot(repo);

    expect(treeDiff(before, after)).toEqual([".claude/skills/graph/octograph.mjs"]);
  });

  it("the shipped pack resources really do install: real payload in, present+current out", () => {
    const repo = mkdtempClean("octograph-command-");
    const t = strictTerminal();
    trapTerminalEvents();
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t.terminal);

    launchInstallGraph(PACK_SRC, repo);

    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
    expect(t.sendText).toHaveBeenCalledOnce();
  });

  it("extension ships no payload: reports it and opens no terminal rather than an ENOENT spawn", () => {
    const src = mkdtempClean("octograph-packsrc-"); // no graph/ dir at all
    const repo = mkdtempClean("octograph-command-");
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    const before = treeSnapshot(repo);
    launchInstallGraph(src, repo);

    expect(term).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
    expect(treeDiff(before, treeSnapshot(repo))).toEqual([]);
  });

  it("a failed install reports the error and opens no terminal — never node on a file we did not write", () => {
    const src = packFixture();
    const repo = mkdtempClean("octograph-command-");
    // A FILE where the payload's directory must go: mkdirSync throws, so the install cannot complete.
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "graph"), "not a directory");
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    expect(() => launchInstallGraph(src, repo)).not.toThrow();

    expect(term).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
  });
});

describe("launchRebuildGraph", () => {
  it("with no workspace folder: reports it and opens no terminal", () => {
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    launchRebuildGraph(undefined);

    expect(err).toHaveBeenCalledOnce();
    expect(term).not.toHaveBeenCalled();
  });

  it("with the bundle not installed: names Install Graph, opens no terminal, installs nothing", () => {
    const repo = mkdtempClean("octograph-command-");
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    const before = treeSnapshot(repo);
    launchRebuildGraph(repo);

    expect(term).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
    const message = err.mock.calls[0]?.[0];
    expect(String(message)).toContain("Install Graph");
    // It must NOT quietly install on the user's behalf — Install Graph is where the yes happens.
    expect(treeDiff(before, treeSnapshot(repo))).toEqual([]);
  });

  it("with the bundle installed: creates a terminal, sends the map command, and shows it", () => {
    const repo = mkdtempClean("octograph-command-");
    installBundle(repo);
    const t = strictTerminal();
    trapTerminalEvents();
    const createTerminal = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t.terminal);

    launchRebuildGraph(repo);

    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: repo }));
    expect(t.sendText).toHaveBeenCalledWith(`node ${GRAPH_RELATIVE_PATH} map`);
    expect(t.show).toHaveBeenCalledOnce();
  });

  it("reads no terminal output, registers no exit handler, writes no state", () => {
    const repo = mkdtempClean("octograph-command-");
    installBundle(repo);
    const t = strictTerminal();
    trapTerminalEvents();
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t.terminal);

    const before = treeSnapshot(repo);
    launchRebuildGraph(repo);

    // Any access beyond sendText/show throws inside the call above; any file write shows up here.
    expect(treeDiff(before, treeSnapshot(repo))).toEqual([]);
  });
});

/**
 * A contributed command with no `registerCommand` is "command 'octoshell.x' not found" at runtime,
 * and nothing else in this suite reads `package.json`'s contributions. This guard fails on a
 * rename applied to one side only — the exact drift the board criterion ("appear in package.json
 * AND are registered in src/extension.ts") is asking about. The reverse direction is deliberately
 * not asserted: the `openXById` commands are registered for tree items and are not palette entries.
 */
describe("command contributions", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  const extensionSrc = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");

  it("every contributed command is registered in extension.ts", () => {
    const unregistered = manifest.contributes.commands
      .map((c) => c.command)
      .filter((id) => !extensionSrc.includes(`registerCommand("${id}"`));
    expect(unregistered).toEqual([]);
  });

  it("both graph commands are contributed with their Octobots titles", () => {
    const byId = new Map(manifest.contributes.commands.map((c) => [c.command, c.title]));
    expect(byId.get("octoshell.installGraph")).toBe("Octobots: Install Graph");
    expect(byId.get("octoshell.rebuildGraph")).toBe("Octobots: Rebuild Graph");
  });
});
