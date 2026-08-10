import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export interface StoredGraph {
  version: 1;
  /** cluster id -> member paths. Read back so the Jaccard remap can pin ids. */
  clusters: Record<number, string[]>;
  /** The config that produced this artifact, so drift in settings is visible. */
  config: Config;
}

/**
 * `.octobots/graph/` when a board exists, else `.octograph/`. An explicit
 * `config.out` always wins, even when a board exists — set by `loadConfig`
 * from `octograph.yaml`, already containment-checked there via `insideRepo`,
 * so it is not re-validated here.
 *
 * Never creates `.octobots/` in a repo that has no board: this only reads
 * with `existsSync`, and the caller (`writeArtifact`) only ever `mkdirSync`s
 * the resolved `graph`/`.octograph` leaf, never `.octobots` itself.
 */
export function resolveOut(repoRoot: string, config: Config): string {
  if (config.out) return join(repoRoot, config.out);
  if (existsSync(join(repoRoot, ".octobots"))) return join(repoRoot, ".octobots", "graph");
  return join(repoRoot, ".octograph");
}

/**
 * Reads back the committed `clusters.json` under `dir`, or `null` if nothing
 * has been written yet (never `{}`, never a throw) — a caller like
 * `remapClusters` needs to tell "no previous run" apart from "previous run
 * produced nothing", and an empty object would collapse that distinction.
 * A malformed file (partial write, hand-edited) degrades to `null` the same
 * way rather than crashing the run.
 */
export function readArtifact(dir: string): StoredGraph | null {
  const path = join(dir, "clusters.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredGraph;
  } catch {
    return null;
  }
}

/**
 * Writes `clusters.json` under `dir` with a stable key/member order so two
 * writes of identical input are byte-identical and a committed diff shows
 * only real change. Cluster ids are sorted numerically (object key order is
 * otherwise insertion order, which callers must not be trusted to hold
 * stable), and each cluster's members are sorted with the default string
 * comparator — never `localeCompare`, which reorders under a changed `LANG`.
 */
export function writeArtifact(dir: string, graph: StoredGraph): void {
  mkdirSync(dir, { recursive: true });
  const ordered: Record<number, string[]> = {};
  for (const key of Object.keys(graph.clusters).map(Number).sort((a, b) => a - b)) {
    ordered[key] = [...(graph.clusters[key] ?? [])].sort();
  }
  writeFileSync(
    join(dir, "clusters.json"),
    JSON.stringify({ ...graph, clusters: ordered }, null, 2) + "\n",
  );
}
