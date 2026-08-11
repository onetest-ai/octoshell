import { existsSync, readFileSync, mkdirSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parsePackVersionMarker } from "./pack-version-marker.js";

/**
 * octograph's pack payload: a self-contained bundle of `packages/graph` (see
 * `scripts/graph-payload.mjs`, which builds and verifies it), installed next to the pack's other
 * skills so a CLI agent and the extension's terminal launcher run identical code. Not a
 * `SKILL.md`-based skill — a plain binary tool — but the design spec places it under
 * `.claude/skills/graph/` regardless, so a CLI agent finds it the same way it finds everything
 * else the pack ships there.
 */
export const GRAPH_ENTRY = "octograph.mjs";

/** `<repoRoot>`-relative path to the installed payload. */
export const GRAPH_RELATIVE_PATH = join(".claude", "skills", "graph", GRAPH_ENTRY);

/**
 * Read the `// octobots-pack-version: N` marker esbuild's banner emits; null if absent.
 *
 * Delegates to the shared `parsePackVersionMarker` — the primer, the tokenomics runner and this
 * payload all carry the SAME marker, so the rule that reads it is spelled once (see
 * `pack-version-marker.ts`).
 */
export function parseGraphVersion(text: string): number | null {
  return parsePackVersionMarker(text);
}

export interface GraphStatus {
  present: boolean;
  current: boolean;
}

/**
 * Inspect the installed graph payload: present if the file exists, current if its version marker
 * matches `packVersion`. Mirrors `tokenomicsStatus`'s shape exactly (see `octobots-tokenomics.ts`)
 * — same three-state result (absent / present-but-stale / current), and a read that THROWS
 * (a directory in the file's place, a permission error) reads as absent rather than propagating.
 *
 * What this does NOT detect, stated plainly rather than implied: a file that reads fine but is
 * TRUNCATED still carries the banner on line 2, so it reports `current`. That is why `installGraph`
 * writes atomically (temp file + rename) instead of copying in place — the version marker is not a
 * content check and must not be asked to act as one.
 *
 * Unlike tokenomics, graph is **opt-in**: a workspace that never ran "Octobots: Install Graph"
 * (M6/T3) is expected to report `present: false`, and that alone must never make the general pack
 * report itself not-installed — see `octobots-skill.ts`'s `packStatus`, which only lets a graph
 * that is present-but-stale flip its `upToDate` verdict.
 */
export function graphStatus(repoRoot: string, packVersion: number): GraphStatus {
  const entry = join(repoRoot, GRAPH_RELATIVE_PATH);
  if (!existsSync(entry)) return { present: false, current: false };
  let v: number | null;
  try {
    v = parseGraphVersion(readFileSync(entry, "utf8"));
  } catch {
    return { present: false, current: false };
  }
  return { present: true, current: v === packVersion };
}

/**
 * Install the graph payload from `<srcRoot>/graph/octograph.mjs` into
 * `<repoRoot>/.claude/skills/graph/octograph.mjs`. Returns the number of files written (0 if the
 * pack ships no graph payload — e.g. a test fixture `srcRoot` that only stubs the parts it needs).
 *
 * A whole-file replace, unlike `installTokenomics`: the payload is a single build artifact with no
 * per-workspace collected state to preserve.
 *
 * **Atomic on purpose — temp file then `renameSync`, never `copyFileSync` onto the live path.**
 * `copyFileSync` opens the destination with `O_TRUNC` before it has read a byte of the source, so a
 * copy that fails part-way (ENOSPC, a source that turns out not to be a regular file, a killed
 * editor) leaves the workspace with the destination destroyed or half-written. Verified 2026-08-11
 * on macOS: a failing `copyFileSync` DELETED an existing, perfectly good `octograph.mjs`. A
 * truncated one would be worse — it still carries the version banner on line 2, so `graphStatus`
 * would report it `current` while `node` on it dies mid-file. Renaming within the same directory is
 * atomic, so a workspace holds either the old payload or the complete new one, never a fragment.
 */
export function installGraph(srcRoot: string, repoRoot: string): number {
  const from = join(srcRoot, "graph", GRAPH_ENTRY);
  if (!existsSync(from)) return 0;
  const toDir = join(repoRoot, ".claude", "skills", "graph");
  mkdirSync(toDir, { recursive: true });
  // Same directory as the target, so the rename is a same-filesystem (atomic) operation.
  const staged = join(toDir, `.${GRAPH_ENTRY}.tmp`);
  try {
    copyFileSync(from, staged);
    renameSync(staged, join(toDir, GRAPH_ENTRY));
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
  return 1;
}
