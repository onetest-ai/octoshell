import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, appendFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parsePackVersionMarker } from "./pack-version-marker.js";

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
 * back to the snapshot we happened to bundle. `prices.local.json` is the workspace's own price
 * additions (models upstream does not list yet); it is hand-edited, so it is never overwritten.
 */
const PRESERVED = new Set(["prices.json", "prices.local.json"]);

/**
 * Read the `// octobots-pack-version: N` marker from the runner; null if absent.
 * Delegates to the shared rule (`pack-version-marker.ts`) — same marker, one spelling.
 */
export function parseTokenomicsVersion(text: string): number | null {
  return parsePackVersionMarker(text);
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
 * Only the files the pack ships are written, except those in `keep`, so collected artifacts already in that directory
 * (`worklog.jsonl`, `raw/segments.jsonl`, `runs.json`, `report.html`) survive an upgrade untouched.
 * Those are the measurements themselves — agent transcripts are pruned outside the repo, so a
 * clobbered artifact is unrecoverable, not merely stale.
 */
export function installTokenomics(srcRoot: string, repoRoot: string, keep: ReadonlySet<string> = new Set()): number {
  const from = join(srcRoot, "tokenomics");
  if (!existsSync(from)) return 0;
  const to = join(repoRoot, ".octobots", "tokenomics");
  mkdirSync(to, { recursive: true });
  ensureIgnored(to);

  let written = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = join(to, entry.name);
    if (PRESERVED.has(entry.name) && existsSync(target)) continue;
    // A file the workspace changed locally (see `installPack`): kept, and staged for reconcile there.
    if (keep.has(entry.name) && existsSync(target)) continue;
    const f = join(from, entry.name);
    if (!statSync(f).isFile()) continue;
    copyFileSync(f, target);
    written++;
  }
  return written;
}

/**
 * Lines `.octobots/tokenomics/.gitignore` must hold. `diagnostics.jsonl` is the dispatch-on-main
 * hook's per-machine warning log: nothing reads it back, so it is never committed. (runs.json,
 * worklog.jsonl and raw/ ARE the project's ledger and stay tracked.)
 */
export const TOKENOMICS_IGNORED = ["diagnostics.jsonl"] as const;

/** Appends each missing `TOKENOMICS_IGNORED` line; the rest of the file is the workspace's own. */
function ensureIgnored(dir: string): void {
  const file = join(dir, ".gitignore");
  let text = "";
  try {
    if (lstatSync(file).isSymbolicLink()) return; // never written through
    text = readFileSync(file, "utf8");
  } catch { /* absent: created below */ }
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = TOKENOMICS_IGNORED.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  appendFileSync(file, (text && !text.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
}
