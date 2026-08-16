/**
 * "Octobots: Doctor" — check that this workspace is configured the way the pack expects.
 *
 * RUNS IN A TERMINAL, DELIBERATELY. The doctor's headline check is `CLAUDE_CONFIG_DIR`, and that is
 * an environment variable of whatever shell actually launches Claude Code. The extension host does
 * not inherit that shell's environment, so running the check in-process would report the host's view
 * — which is not the value any agent will see. A terminal is the only place the answer is real.
 *
 * Prefers the workspace's installed copy so the doctor matches the pack the repo is actually on; the
 * bundled copy is the fallback for a workspace that has not installed the pack yet, which is itself
 * one of the things worth reporting.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

/** Relative to the repo root — where `installPack` puts the doctor. */
const INSTALLED_REL = join(".claude", "skills", "mission-planner", "scripts", "doctor.js");

/** Quote a path for a POSIX or PowerShell command line; both accept double quotes around a path. */
function q(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/**
 * Resolve which doctor script to run: the workspace's installed copy when present, else the one
 * bundled with this extension build. Exported for the test — the choice is the interesting part.
 */
export function resolveDoctorScript(repoRoot: string, packSrcRoot: string): string {
  const installed = join(repoRoot, INSTALLED_REL);
  if (existsSync(installed)) return installed;
  return join(packSrcRoot, "skill", "mission-planner", "scripts", "doctor.js");
}

export function launchDoctor(packSrcRoot: string, repoRoot: string | undefined): void {
  if (!repoRoot) {
    void vscode.window.showWarningMessage("Octobots: open a folder first.");
    return;
  }
  const script = resolveDoctorScript(repoRoot, packSrcRoot);
  const terminal = vscode.window.createTerminal({ cwd: repoRoot, name: "Octobots Doctor" });
  terminal.sendText(`node ${q(script)} --root ${q(repoRoot)}`);
  terminal.show();
}
