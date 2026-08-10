import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { insideRepo } from "./paths.js";
import { compare } from "./rollup.js";

export interface StoredGraph {
  version: 1;
  /** cluster id -> member paths. Read back so the Jaccard remap can pin ids. */
  clusters: Record<number, string[]>;
  /** The config that produced this artifact, so drift in settings is visible. */
  config: Config;
  /**
   * The --since window this artifact's git history was harvested with, or
   * `null` for a full-history run. NOT part of Config: it's a per-invocation
   * query (git log --since), never an octograph.yaml setting, so folding it
   * into `config` would misrepresent it as project configuration.
   *
   * OPTIONAL, not required: every clusters.json written before this field
   * existed lacks the key entirely, and that absence is a real "we don't
   * know" state — distinct from a confirmed `null` (we know it was full
   * history). A caller comparing provenance across runs must tell the two
   * apart rather than assuming an old artifact was full-history.
   */
  since?: string | null;
}

/**
 * Whether this repo has an Octobots board — the ONE place that question is
 * asked of the filesystem.
 *
 * Two consumers ask it and they must never disagree: `resolveOut` below picks
 * where the artifact is written on the strength of it, and `doctor` grades a
 * "board" check on the strength of it. Spelled independently in the two
 * modules (which is how it arrived — `artifact.ts` from T3.3, `doctor.ts` from
 * T3.2), they are free to drift the day the directory is renamed or the
 * predicate is tightened, and the failure is silent and confusing in exactly
 * the way this package's other single-spelling rules were: doctor reports
 * "board found" while `map` writes into `.octograph/`, or the reverse. Same
 * treatment as `graphifyGraphPath` (graphify.ts) — one producer, two readers,
 * enforced structurally by `test/conventions.test.ts`.
 */
export function hasBoard(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".octobots"));
}

/**
 * `.octobots/graph/` when a board exists, else `.octograph/`. An explicit
 * `config.out` wins over both, even when a board exists.
 *
 * `out` is containment-checked HERE, through the same `insideRepo` helper
 * `loadConfig` and `readGraphify` use, and not on the strength of an earlier
 * check. `loadConfig` validates the `octograph.yaml` spelling of `out` but its
 * override loop does not — and the override loop is exactly what the documented
 * `--out` CLI flag feeds, so `octograph map --out ../../../tmp` reaches this
 * function with an escaping value that has passed no check at all. This is the
 * one place `out` becomes a filesystem location a write lands in, so the check
 * belongs at this seam rather than upstream of some of its callers. An escaping
 * value degrades to the default location — the same "skip the assignment rather
 * than throw" convention `loadConfig` applies to every other bad setting.
 *
 * The containment check is a gate only: the returned path is
 * `resolve(repoRoot, out)`, not `insideRepo`'s realpath-resolved form, so the
 * caller still gets a path in the namespace it passed in.
 *
 * `resolve`, not `join`. `join(repoRoot, out)` CONCATENATES an absolute `out`
 * onto the root — `--out /Users/me/proj/build/graph` inside `/Users/me/proj`
 * passed the containment gate (the path really is inside the repo) and then
 * wrote to `/Users/me/proj/Users/me/proj/build/graph`, a bogus tree nested
 * under the repo that the user never named and the run then reported as the
 * place it wrote. An absolute path is exactly what a caller that resolved the
 * directory itself hands over — the VS Code commands in M6, or any script
 * that expands `$PWD` — so this is the ordinary case, not a corner. `resolve`
 * returns an absolute `out` unchanged and joins a relative one, which is the
 * behaviour both spellings of `out` (the flag and octograph.yaml's key) mean.
 *
 * Never creates `.octobots/` in a repo that has no board: this only reads
 * with `existsSync`, and the caller (`writeArtifact`) only ever `mkdirSync`s
 * the resolved `graph`/`.octograph` leaf, never `.octobots` itself.
 */
export function resolveOut(repoRoot: string, config: Config): string {
  if (config.out && insideRepo(repoRoot, config.out) !== null) {
    return resolve(repoRoot, config.out);
  }
  if (hasBoard(repoRoot)) return join(repoRoot, ".octobots", "graph");
  return join(repoRoot, ".octograph");
}

/**
 * Reads back the committed `clusters.json` under `dir`, or `null` if nothing
 * usable has been written yet (never `{}`, never a throw) — a caller like
 * `remapClusters` needs to tell "no previous run" apart from "previous run
 * produced nothing", and an empty object would collapse that distinction.
 *
 * "Never a throw" has to cover the CALLER too, or it buys nothing: the artifact
 * is a committed file that survives merges and hand edits, and a `clusters.json`
 * holding valid JSON of the wrong shape (`{}`, a bare number, a v2 written by a
 * later octograph) would otherwise be handed back verbatim and crash the run at
 * `Object.entries(previous.clusters)` one frame up. So the parsed document is
 * shape-checked before it is returned, and anything that is not a v1
 * `StoredGraph` degrades to `null` exactly like an unparseable file — the run
 * then treats it as "no previous run", re-mints cluster ids once, and rewrites
 * a good artifact.
 */
export function readArtifact(dir: string): StoredGraph | null {
  const path = join(dir, "clusters.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isStoredGraph(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A cluster id as it can legally appear as a JSON object key: the canonical
 * decimal spelling of a non-negative integer, and nothing else.
 *
 * `StoredGraph.clusters` is typed `Record<number, string[]>`, but JSON has no
 * integer keys — every key on disk is a string, and TypeScript vouches for
 * none of them. The gap is not cosmetic. `cli.ts` converts each key with
 * `Number(id)` and `remapClusters` then computes `Math.max(...oldIds) + 1` to
 * mint fresh ids: one key that does not parse makes that arithmetic `NaN`,
 * every unmatched module is assigned the id `NaN`, and `analysisToClusters`
 * collapses ALL of them onto the single object key `"NaN"` — a committed
 * artifact that has silently lost every module but one, while `clusterIds`
 * reports `{ kept: <all>, fresh: 0 }` because `Map.has(NaN)` is true. The next
 * run reads that artifact back and stays broken, so the damage is
 * self-perpetuating. Reproduced end to end before this guard existed.
 *
 * Canonical spelling specifically, not "parses as a number": `"1.0"`, `" 1"`,
 * `"+1"`, `"0x2"` and `"1e3"` all survive `Number()` and none of them is a key
 * `writeArtifact` can ever produce (it writes integer object keys, which JS
 * stringifies canonically). Accepting them would round-trip an id to a
 * DIFFERENT key on the next write — churn in a committed diff for a file that
 * did not change.
 */
const CLUSTER_KEY = /^(0|[1-9][0-9]*)$/;

/**
 * The half of {@link StoredGraph} a consumer actually reads: `version`, and a
 * `clusters` map of id -> string members. `config` is deliberately NOT
 * validated — nothing computes from it (it exists so a settings change is
 * visible in the diff), and a strict check there would reject every artifact
 * written before a new `Config` key was added, throwing away cluster ids for a
 * field no caller reads. `since` gets the same treatment for the same reason:
 * it is optional precisely so a pre-fix artifact missing the key entirely
 * still passes, and `parsed` is returned as-is (never reconstructed field by
 * field), so a present `since` — a string, or an explicit `null` — survives
 * untouched without this function needing to know its shape.
 *
 * `clusters`' KEYS are validated as strictly as its values, for the reason
 * spelled out on {@link CLUSTER_KEY}: they are arithmetic input one frame up,
 * not labels.
 */
function isStoredGraph(value: unknown): value is StoredGraph {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as { version?: unknown; clusters?: unknown };
  if (doc.version !== 1) return false;
  const clusters = doc.clusters;
  if (clusters === null || typeof clusters !== "object" || Array.isArray(clusters)) return false;
  for (const [id, members] of Object.entries(clusters as Record<string, unknown>)) {
    if (!CLUSTER_KEY.test(id)) return false;
    if (!Array.isArray(members)) return false;
    if (members.some((m) => typeof m !== "string")) return false;
  }
  return true;
}

/**
 * Writes `clusters.json` under `dir` with a stable key/member order so two
 * writes of equal input are byte-identical and a committed diff shows only real
 * change. Every order that reaches the file is explicit:
 *
 *  - cluster ids sorted numerically;
 *  - each cluster's members sorted with `compare`, this package's one ordering
 *    rule — never `localeCompare`, which reorders under a changed `LANG`;
 *  - the top-level keys, and `config`'s keys, sorted the same way. Those two
 *    would otherwise follow the INSERTION order of the object literal the
 *    caller assembled and of the `Config` literal in config.ts — neither of
 *    which is part of the artifact's meaning, and either of which reorders the
 *    whole committed file on a refactor that changed nothing. Unknown keys are
 *    carried through rather than dropped, so a field added to `StoredGraph`
 *    later cannot be silently lost here.
 */
export function writeArtifact(dir: string, graph: StoredGraph): void {
  mkdirSync(dir, { recursive: true });
  const ordered: Record<number, string[]> = {};
  for (const key of Object.keys(graph.clusters).map(Number).sort((a, b) => a - b)) {
    ordered[key] = [...(graph.clusters[key] ?? [])].sort(compare);
  }
  const payload = withSortedKeys({
    ...graph,
    clusters: ordered,
    config: withSortedKeys(graph.config),
  });
  writeFileSync(join(dir, "clusters.json"), JSON.stringify(payload, null, 2) + "\n");
}

/**
 * A shallow copy of `record` with its own keys in `compare` order.
 *
 * `clusters` is passed through by reference, NOT re-sorted here: its keys are
 * integer-like, and JS own-property order already emits those ascending
 * numerically, which is the order `writeArtifact` built. Running them through a
 * string comparator instead would put "10" before "2".
 */
function withSortedKeys(record: object): Record<string, unknown> {
  const source = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compare)) out[key] = source[key];
  return out;
}
