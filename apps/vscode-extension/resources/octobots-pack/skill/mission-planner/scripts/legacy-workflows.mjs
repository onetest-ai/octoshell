// Leftover `workflows/` folders. Workflow support was removed in pack v57: the board model ignores
// these folders and no script reads them. They are the user's data, so they are only ever REPORTED
// here — never touched. (Deleting one is octobots-doctor's job, with the user's OK.)
//
// One rule, one message: validate.js and doctor.js both go through this file. The board library's
// validateBoard is to mirror the exact warning text once it drops the Workflow entity (M3 T3.3) —
// from then on, keep the two in step.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

export const NO_LONGER_READ = "no longer read since pack v57";

/** The `warning:` line for one folder; `rel` is its path relative to the board root, `/`-separated. */
export function legacyWorkflowsWarning(rel) {
  return `warning: ${rel}: ${NO_LONGER_READ}`;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * The board root (the folder holding `campaigns/`) that `dir` sits in: the nearest `.octobots`
 * ancestor, else the parent of the nearest `campaigns` ancestor (a board copied to a folder with
 * another name), else `dir` itself. Paths are reported relative to it, as validateBoard(root) does.
 */
export function boardRootOf(dir) {
  const start = resolve(dir);
  for (let d = start; d !== parse(d).root; d = dirname(d)) if (basename(d) === ".octobots") return d;
  for (let d = start; d !== parse(d).root; d = dirname(d)) if (basename(d) === "campaigns") return dirname(d);
  return start;
}

/**
 * Leftover workflow folders belonging to the campaign or mission folder `dir`: those in its own
 * `workflows/`, plus those of every mission under `dir/missions/`. Each `workflows/<slug>/` is one
 * folder; a `workflows/` holding no sub-folder is reported as itself. Returned as paths relative to
 * `base` (the board root), `/`-separated, sorted.
 */
export function findLegacyWorkflowFolders(dir, base) {
  const found = [];
  const check = (d) => {
    const w = join(d, "workflows");
    if (!isDir(w)) return;
    const slugs = readdirSync(w, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(w, e.name));
    found.push(...(slugs.length ? slugs : [w]));
  };
  check(dir);
  const missions = join(dir, "missions");
  if (existsSync(missions) && isDir(missions)) {
    for (const e of readdirSync(missions, { withFileTypes: true })) if (e.isDirectory()) check(join(missions, e.name));
  }
  return found.map((w) => relative(base, w).split(sep).join("/")).sort();
}
