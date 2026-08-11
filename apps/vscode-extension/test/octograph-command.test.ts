import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { launchInstallGraph, launchRebuildGraph } from "../src/host/octograph-command.js";
import { GRAPH_RELATIVE_PATH } from "../src/host/octograph-install.js";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/**
 * A terminal whose ONLY spied surface is sendText/show — matching `sdlc-bundles-command.test.ts`'s
 * shape. Because nothing else is stubbed, any call this module makes beyond those two (reading
 * output, an exit/close handler, anything else) throws "not a function" rather than silently
 * passing — that IS the "no output capture, no exit handler" assertion, not a separate check.
 */
function spyTerminal(): { sendText: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> } {
  return { sendText: vi.fn(), show: vi.fn() };
}

function installBundle(repo: string): void {
  const dir = join(repo, ".claude", "skills", "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "octograph.mjs"), `// octobots-pack-version: ${OCTOBOTS_PACK_VERSION}\nbody`);
}

afterEach(() => vi.restoreAllMocks());

describe("launchInstallGraph", () => {
  it("with no workspace folder: reports it and opens no terminal", () => {
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    launchInstallGraph(undefined);

    expect(err).toHaveBeenCalledOnce();
    expect(term).not.toHaveBeenCalled();
  });

  it("creates a terminal cwd'd to the workspace, sends the setup command, and shows it", () => {
    const t = spyTerminal();
    const createTerminal = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);

    launchInstallGraph("/repo");

    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
    expect(t.sendText).toHaveBeenCalledWith("node .claude/skills/graph/octograph.mjs setup");
    expect(t.show).toHaveBeenCalledOnce();
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

  it("with the bundle not installed: names Install Graph and opens no terminal — no ENOENT spawn", () => {
    const repo = mkdtempClean("octograph-command-");
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");

    launchRebuildGraph(repo);

    expect(term).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
    expect(err.mock.calls[0]![0]).toContain("Install Graph");
  });

  it("with the bundle installed: creates a terminal, sends the map command, and shows it", () => {
    const repo = mkdtempClean("octograph-command-");
    installBundle(repo);
    const t = spyTerminal();
    const createTerminal = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);

    launchRebuildGraph(repo);

    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: repo }));
    expect(t.sendText).toHaveBeenCalledWith(`node ${GRAPH_RELATIVE_PATH} map`);
    expect(t.show).toHaveBeenCalledOnce();
  });
});
