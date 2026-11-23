import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, appendFileSync } from "node:fs";
import { readRegularText } from "./pack-updates.js";
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

/** What `installPack` reports about a workspace `prices.json` it kept rather than replaced. */
export interface PricesKept {
  kept: true;
  /** The pack's table is newer than the workspace's, or the workspace's has no readable `fetched_at`. */
  stale: boolean;
  workspaceFetchedAt: string | null;
  packFetchedAt: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The `fetched_at` date (YYYY-MM-DD) of a price table, or null when the file cannot be read as one. */
function fetchedAt(file: string): string | null {
  try {
    const v = (JSON.parse(readRegularText(file, { noFollow: true, max: 16 * 1024 * 1024 })) as { fetched_at?: unknown }).fetched_at;
    return typeof v === "string" && DATE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Describes the workspace `prices.json` that `installTokenomics` will keep (see `PRESERVED`), or
 * undefined when there is none and the pack's table is installed. A kept table is never staged for
 * reconcile: `update-prices.mjs` rewrites it, so it differs from the pack's in every workspace that
 * has refreshed. The install reports it instead, so an old table does not stay unnoticed.
 */
export function pricesKept(srcRoot: string, repoRoot: string): PricesKept | undefined {
  const target = join(repoRoot, ".octobots", "tokenomics", "prices.json");
  if (!existsSync(target)) return undefined;
  const workspaceFetchedAt = fetchedAt(target);
  const packFetchedAt = fetchedAt(join(srcRoot, "tokenomics", "prices.json"));
  const stale = workspaceFetchedAt === null || (packFetchedAt !== null && workspaceFetchedAt < packFetchedAt);
  return { kept: true, stale, workspaceFetchedAt, packFetchedAt };
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
    // A file the workspace changed locally (kept, and staged by `installPack`) or a symlink, dangling
    // ones included: `existsSync` would follow the link, and the copy would create its target.
    if (keep.has(entry.name)) continue;
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

/**
 * Appends each missing `TOKENOMICS_IGNORED` line; the rest of the file is the workspace's own. The
 * file is read only as a small regular file (never a symlink, FIFO or directory: those would hang or
 * abort the install), and a failure to read or write it is left alone, never raised: an ignore line
 * is not worth a half-finished install.
 */
function ensureIgnored(dir: string): void {
  const file = join(dir, ".gitignore");
  let text = "";
  try {
    text = readRegularText(file, { noFollow: true, max: 1024 * 1024 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return; // present but not a plain file: leave it
  }
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = TOKENOMICS_IGNORED.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  try {
    appendFileSync(file, (text && !text.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  } catch { /* unwritable: the install goes on */ }
}
