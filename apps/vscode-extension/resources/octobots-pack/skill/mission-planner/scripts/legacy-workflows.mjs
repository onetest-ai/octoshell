// Leftover `workflows/` folders. Workflow support was removed in pack v57: the board model ignores
// these folders and no script reads them. They are the user's data, so they are only ever REPORTED
// here — never touched. (Deleting one is octobots-doctor's job, with the user's OK.)
//
// One rule, one message: validate.js and doctor.js both go through this file. The board library's
// validateBoard mirrors the exact warning text — keep the two in step.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const NO_LONGER_READ = "no longer read since pack v57";

/** The `warning:` line for one folder; `rel` is its path relative to `.octobots/`, `/`-separated. */
export function legacyWorkflowsWarning(rel) {
  return `warning: ${rel}: ${NO_LONGER_READ}`;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * `workflows/` folders belonging to the campaign or mission folder `dir`: its own, plus those of
 * every mission under `dir/missions/`. Returned as paths relative to `base` (the `.octobots/` dir),
 * `/`-separated, sorted.
 */
export function findLegacyWorkflowFolders(dir, base) {
  const found = [];
  const check = (d) => { const w = join(d, "workflows"); if (isDir(w)) found.push(w); };
  check(dir);
  const missions = join(dir, "missions");
  if (existsSync(missions) && isDir(missions)) {
    for (const e of readdirSync(missions, { withFileTypes: true })) if (e.isDirectory()) check(join(missions, e.name));
  }
  return found.map((w) => relative(base, w).split(sep).join("/")).sort();
}
