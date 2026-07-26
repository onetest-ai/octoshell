import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The tokenomics CLI: `run.mjs` (collect → rollup → render) and the stages it drives.
 *
 * It ships with the pack rather than living in the extension because the mission gate runs it from
 * a CLI agent, with no editor in the loop — and because it reads the board's entity files directly.
 * A copy maintained per-workspace drifts from the board schema silently: an earlier hand-vendored
 * copy still read `mission.md` after the md→yaml migration, found no missions, and reported an
 * entire board's cost as unattributed without erroring.
 */
export const TOKENOMICS_ENTRY = "run.mjs";

/**
 * Files the workspace owns after the first install. `prices.json` is a cache that
 * `update-prices.mjs` refreshes from upstream, so re-installing must not roll a refreshed table
 * back to the snapshot we happened to bundle.
 */
const PRESERVED = new Set(["prices.json"]);

/** Read the `// octobots-pack-version: N` marker from the runner; null if absent. */
export function parseTokenomicsVersion(text: string): number | null {
  const m = text.match(/octobots-pack-version:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export interface TokenomicsStatus {
  present: boolean;
  current: boolean;
}

/** Inspect the installed CLI: present if the runner exists, current if it carries this version. */
export function tokenomicsStatus(repoRoot: string, version: number): TokenomicsStatus {
  const entry = join(repoRoot, ".octobots", "tokenomics", TOKENOMICS_ENTRY);
  if (!existsSync(entry)) return { present: false, current: false };
  let v: number | null;
  try { v = parseTokenomicsVersion(readFileSync(entry, "utf8")); } catch { return { present: false, current: false }; }
  return { present: true, current: v === version };
}

/**
 * Install the CLI into `<repoRoot>/.octobots/tokenomics/`.
 *
 * Only the files the pack ships are written, so collected artifacts already in that directory
 * (`worklog.jsonl`, `raw/segments.jsonl`, `runs.json`, `report.html`) survive an upgrade untouched.
 * Those are the measurements themselves — agent transcripts are pruned outside the repo, so a
 * clobbered artifact is unrecoverable, not merely stale.
 */
export function installTokenomics(srcRoot: string, repoRoot: string): number {
  const from = join(srcRoot, "tokenomics");
  if (!existsSync(from)) return 0;
  const to = join(repoRoot, ".octobots", "tokenomics");
  mkdirSync(to, { recursive: true });

  let written = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = join(to, entry.name);
    if (PRESERVED.has(entry.name) && existsSync(target)) continue;
    const f = join(from, entry.name);
    if (!statSync(f).isFile()) continue;
    copyFileSync(f, target);
    written++;
  }
  return written;
}
