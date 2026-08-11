import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

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

/** Read the `// octobots-pack-version: N` marker esbuild's banner emits; null if absent. */
export function parseGraphVersion(text: string): number | null {
  const m = text.match(/octobots-pack-version:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export interface GraphStatus {
  present: boolean;
  current: boolean;
}

/**
 * Inspect the installed graph payload: present if the file exists, current if its version marker
 * matches `packVersion`. Mirrors `tokenomicsStatus`'s shape exactly (see `octobots-tokenomics.ts`)
 * — same three-state result (absent / present-but-stale / current), same "any read failure reads
 * as absent" behavior, so a corrupt or half-written file never masquerades as current.
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
 * A plain overwrite, unlike `installTokenomics`: the payload is a single build artifact with no
 * per-workspace collected state to preserve.
 */
export function installGraph(srcRoot: string, repoRoot: string): number {
  const from = join(srcRoot, "graph", GRAPH_ENTRY);
  if (!existsSync(from)) return 0;
  const toDir = join(repoRoot, ".claude", "skills", "graph");
  mkdirSync(toDir, { recursive: true });
  copyFileSync(from, join(toDir, GRAPH_ENTRY));
  return 1;
}
