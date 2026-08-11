import * as vscode from "vscode";
import { graphCommand } from "./octograph.js";
import { graphStatus } from "./octograph-install.js";
import { OCTOBOTS_PACK_VERSION } from "./octobots-skill.js";

/**
 * Thin launchers behind "Octobots: Install Graph" and "Octobots: Rebuild Graph" — mirrors
 * `sdlc-bundles-command.ts`'s shape exactly: open an integrated terminal on the workspace root,
 * send the ONE command string `octograph.ts` built, show it, and stop. No output capture, no exit
 * or close handler, no state written anywhere (there is no `ExtensionContext` in this module's
 * signature at all, so there is nothing to write it with). The terminal is the interface; `doctor`
 * — run inside it by the bundle itself — is what judges whether the run succeeded, not this
 * module. See `src/host/octograph.ts` for why the command strings this sends are safe by
 * construction (bare `node`, no interpolation).
 */

function reportNoWorkspace(): void {
  void vscode.window.showErrorMessage("Octobots: open a workspace folder first.");
}

/** "Octobots: Install Graph" — first-run flow: health checks, prompted installs, initial build. */
export function launchInstallGraph(repoRoot: string | undefined): void {
  if (!repoRoot) {
    reportNoWorkspace();
    return;
  }
  const terminal = vscode.window.createTerminal({ cwd: repoRoot, name: "Octobots Graph" });
  terminal.sendText(graphCommand("setup"));
  terminal.show();
}

/**
 * "Octobots: Rebuild Graph" — the routine path. Checks the SAME `graphStatus` the pack's own
 * drift/upgrade prompt uses (`octobots-skill.ts`'s `packStatus`) so "is the bundle installed" is
 * asked exactly once, not re-derived a third way here — a missing bundle would otherwise spawn
 * `node` on a path that does not exist and hand the user a bare ENOENT in the terminal, which is
 * precisely the failure `Install Graph`'s own pack-payload wiring (M6/T1) exists to prevent.
 */
export function launchRebuildGraph(repoRoot: string | undefined): void {
  if (!repoRoot) {
    reportNoWorkspace();
    return;
  }
  if (!graphStatus(repoRoot, OCTOBOTS_PACK_VERSION).present) {
    void vscode.window.showErrorMessage(
      'Octobots: the graph bundle isn\'t installed yet — run "Octobots: Install Graph" first.',
    );
    return;
  }
  const terminal = vscode.window.createTerminal({ cwd: repoRoot, name: "Octobots Graph" });
  terminal.sendText(graphCommand("map"));
  terminal.show();
}
