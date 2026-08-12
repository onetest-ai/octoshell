import * as vscode from "vscode";
import { graphCommand } from "./octograph.js";
import { graphStatus, installGraph } from "./octograph-install.js";
import { OCTOBOTS_PACK_VERSION } from "./octobots-skill.js";

/**
 * Thin launchers behind "Octobots: Install Graph" and "Octobots: Rebuild Graph": open an
 * integrated terminal on the workspace root, send the ONE command string `octograph.ts` built,
 * show it, and stop. No output capture, no exit or close handler, no run state written anywhere.
 * The terminal is the interface; `doctor` — run inside it by the bundle itself — is what judges
 * whether the run succeeded, not this module. See `src/host/octograph.ts` for why the command
 * strings this sends are safe by construction (bare `node`, no interpolation).
 *
 * "Thin" is enforced by `test/octograph-command.test.ts`, not by this comment: the terminal it
 * hands these functions throws on ANY property access other than `sendText`/`show`, every
 * terminal-event registrar on `vscode.window` throws by name, and the fixture repo's file tree is
 * snapshotted before and after. An earlier version of that test only stubbed `sendText`/`show`
 * and claimed the missing members "would throw" — a planted `writeFileSync` and a planted
 * `terminal.exitStatus` read both passed it green (verified 2026-08-11).
 *
 * The ONE write either function performs is the graph payload itself, in `launchInstallGraph`,
 * and it is the command's whole point — see below.
 */

function reportNoWorkspace(): void {
  void vscode.window.showErrorMessage("Octobots: open a workspace folder first.");
}

/**
 * "Octobots: Install Graph" — the first-run flow: install the bundled payload into the workspace,
 * then run `setup` (health checks, prompted installs, initial build) in a terminal.
 *
 * **The install step is not optional glue, it is the only thing that ever puts the payload on
 * disk.** `installPack` deliberately refreshes graph only when it is ALREADY present
 * (`octobots-skill.ts`, "graph is opt-in"), and that comment names *this* command as the opt-in.
 * Without the `installGraph` call below, nothing in the extension ever installed the bundle: the
 * terminal spawned `node` on a path that does not exist, `Rebuild Graph` correctly reported the
 * bundle missing and pointed here, and here handed the user the bare ENOENT anyway — a closed
 * loop with no way out (found in review of M6/T3, 2026-08-11).
 *
 * Explicit invocation of this command IS the consent to write; nothing here installs on
 * activation, on a `Rebuild Graph` retry, or on any error path. `installGraph` stages to a temp
 * file and renames, so a failure leaves the previous payload intact rather than a fragment — and
 * a failure is REPORTED and opens no terminal, instead of launching `node` on the file that was
 * not written.
 */
export function launchInstallGraph(packSrcRoot: string, repoRoot: string | undefined): void {
  if (!repoRoot) {
    reportNoWorkspace();
    return;
  }
  let written: number;
  try {
    written = installGraph(packSrcRoot, repoRoot);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Octobots: could not install the graph bundle — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (written === 0) {
    // The payload is committed pack resource (see `scripts/graph-payload.mjs`), so this means the
    // installed extension is missing a file it ships. Say so rather than opening a terminal that
    // would ENOENT on the very path we just failed to write.
    void vscode.window.showErrorMessage(
      "Octobots: this build of the extension ships no graph bundle — reinstall the extension.",
    );
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
 * `node` on a path that does not exist and hand the user a bare ENOENT in the terminal. This
 * command never installs anything itself: it names `Install Graph`, which is the one place the
 * user says yes to a write.
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
