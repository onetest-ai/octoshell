/**
 * `conflicts <mission|campaign|...tasks>`: whether a SET of tasks decomposes
 * a mission cleanly — over the same predicted-surface machinery `own.ts`
 * (T4.4) built (`predictFiles` against the co-change file corpus), never a
 * second lexical layer.
 *
 * `predicted` mode, permanently — not a degraded fallback the way `own`'s
 * `predicted` is when a merge SHA is missing. A planned task has no merge
 * yet, so there is nothing `provenance` could mean for it: `attribution.ts`
 * and `readWorklog` are therefore never imported here. Reading the worklog
 * anyway would make this command's answer depend on which tasks in the SAME
 * set happen to already be merged, so a mission's day-one board and its
 * fully-executed one would disagree about its own decomposition — see this
 * module's own tests for the fixture that pins this.
 *
 * **The spec's "summed nPMI over predicted surfaces" is wrong, and is not
 * followed here.** `weighEdges` never emits a self-pair (a file paired with
 * itself) and `rollUp` drops self-loops, so two tasks predicting the SAME
 * file have no edge between them and would sum to zero under a summed-nPMI
 * rule alone — the clearest possible decomposition conflict scoring as if it
 * were nothing. {@link ConflictPair} therefore reports TWO fields, never
 * blended into one:
 *
 *  - `shared` — the literal intersection of two tasks' predicted files, the
 *    direct collision.
 *  - `coupled` — summed `edgeWeight` over CROSS pairs of DISTINCT files, one
 *    predicted by each task, the signal `shared` cannot see: two tasks
 *    touching different files that history says always move together.
 *
 * Blending them into one number would be the same defect as the module row
 * that said "21 files" while counting something narrower, and the edge
 * weight that meant a count on one branch and an nPMI sum on the other — one
 * figure meaning two different things depending on which branch produced it.
 */
import type { Analysis } from "./analyze.js";
import type { BoardTask } from "./board.js";
import { isSyntheticBridge } from "./components.js";
import { predictFiles, type LexicalOptions } from "./lexical.js";
import { classifyPair } from "./noise.js";
import { compare } from "./rollup.js";
import { edgeWeight, type Edge } from "./weights.js";

export interface ConflictPair {
  /** The two tasks in conflict, `compare`-ordered — never the order `tasks`
   *  arrived in, so the same pair reports identically whichever of the two
   *  a caller lists first. */
  a: string;
  b: string;
  /**
   * How this answer was reached — `"predicted"`, always, and typed as that
   * single literal so no branch here can ever widen it (mission criterion:
   * "every answer from `own` or `conflicts` names which mode produced it").
   *
   * Constant BY CONSTRUCTION, not by omission: unlike `own`'s `mode`, which
   * really does move with the evidence (a resolvable merge SHA gives
   * `provenance`, its absence gives `predicted`), a planned task has no merge
   * to read, so `attribution.ts` and `readWorklog` are not imported by this
   * module at all — there is no code path here that could produce another
   * value. An unlabelled answer would be the worse failure: `own` prints a
   * mode on every row, so a `conflicts` row printed beside it with none reads
   * as the stronger claim, when both `shared` and `coupled` rest entirely on
   * `predictFiles`' lexical guess about which files each task will touch.
   * `coupled` is no exception — its nPMI is real history, but the two
   * SURFACES it is measured between are predicted.
   */
  mode: "predicted";
  /** Files BOTH tasks' predicted surfaces name — the direct collision.
   *  Never summed into `coupled`; see this module's doc comment.
   *  `compare`-sorted, and filtered of manifest/lockfile and test-subject
   *  noise through {@link classifyPair} — see {@link isNoiseOnItsOwn}. */
  shared: string[];
  /** Summed `edgeWeight` over every pair of DISTINCT files (one predicted by
   *  `a`, one by `b`) that survive the same noise floor — evidence the two
   *  tasks' work areas move together historically even though they name no
   *  file in common. Always `>= 0`; `0` when no such pair exists. */
  coupled: number;
  /** Declared modules (`analysis.modules`) that BOTH tasks' predicted
   *  surfaces touch — `compare`-ordered, deduplicated. */
  modules: string[];
}

/** path -> declared module name, built once per call so every task's
 *  surface reads the same map rather than re-deriving it per pair. Reads
 *  only `analysis.modules`, never clustering/hubs/edges — the declared
 *  identity `filesByModule` produces (see spine.ts), not a discovered one. */
function moduleOfFile(analysis: Analysis): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of analysis.modules) for (const f of m.members) map.set(f, m.name);
  return map;
}

interface TaskSurface {
  task: BoardTask;
  /** The task's predicted files, `compare`-sorted — `predictFiles`'s own
   *  tied-for-top-score answer, exactly as `own.ts` reads it for a task's
   *  full inventory (`path === null`, i.e. "every file this task owns").
   *  Usually 0 or 1 file; more only on an exact score tie. */
  files: string[];
  /** Declared modules those files live in, per {@link moduleOfFile}. */
  modules: Set<string>;
}

function surfaceFor(
  task: BoardTask,
  candidates: readonly string[],
  modOf: ReadonlyMap<string, string>,
  lexical: LexicalOptions,
): TaskSurface {
  const files = predictFiles(task.criteria, candidates, lexical)
    .map((m) => m.file)
    .sort(compare);
  const modules = new Set<string>();
  for (const f of files) {
    const m = modOf.get(f);
    if (m !== undefined) modules.add(m);
  }
  return { task, files, modules };
}

/**
 * Whether a file both tasks predict is noise on its own, per the SAME
 * `classifyPair` `drift` ranks a real co-change edge against — never a
 * hand-rolled "is this a manifest" predicate.
 *
 * `classifyPair` grades a PAIR, so asking it about one file means choosing
 * what to pair that file with, and the choice is the whole rule:
 *
 *  - **Against itself** (`classifyPair(f, f)`, which reduces to
 *    `isTestPath(f)` — the mechanical branch can never fire for two equal
 *    filenames, since a manifest never also matches its own lockfile's
 *    pattern; see `noise.ts`). Two tasks both predicting the same test file
 *    is exactly as uninformative as two tasks both predicting the same
 *    lockfile.
 *  - **Against every OTHER file in the candidate corpus.** A lone
 *    `package.json` in `shared` — with no lockfile alongside it, which is the
 *    ordinary case, since a task criterion naming the manifest rarely also
 *    names the lock — is graded `"candidate"` against itself and would
 *    otherwise be reported as a conflict. It is `classifyPair(package.json,
 *    pnpm-lock.yaml)` that knows the file is mechanical, and that lockfile is
 *    sitting in `corpus`. Pairing only WITHIN `shared` (the first version of
 *    this function) suppressed the manifest exactly when a task's criteria
 *    happened to name both halves of the pair, and the board's own acceptance
 *    criterion — "a manifest every task touches produces no conflict on its
 *    own" — held only for that wording.
 *
 * Evidence-shaped, not name-shaped: a `package.json` in a repo whose corpus
 * holds no lockfile that {@link classifyPair} says governs it is NOT
 * suppressed, because nothing in this repository's history says its coupling
 * is mechanical. That is `classifyPair`'s judgement, made where it lives,
 * rather than a second predicate here re-deciding what a manifest is.
 *
 * Never checked against the OTHER task's fuller surface, only against the
 * corpus: an unrelated test file in one task's surface must not drag a real
 * shared file down with it.
 */
function isNoiseOnItsOwn(file: string, corpus: readonly string[]): boolean {
  if (classifyPair(file, file) !== "candidate") return true;
  for (const other of corpus) {
    if (other === file) continue;
    if (classifyPair(file, other) === "mechanical") return true;
  }
  return false;
}

/**
 * Index `edges` by their (ordered) endpoint ids, so a (fileA, fileB) cross
 * pair can be looked up without a linear scan per pair — this package's edge
 * lists run into the thousands on a real repo, and this module looks one up
 * per candidate pair per task pair.
 *
 * Synthetic bridges ({@link isSyntheticBridge}) are excluded at index-build
 * time, never per lookup: a bridge is backed by no commit (`support: 0`) and
 * asserts nothing about the repository, exactly as `rollUp` refuses the
 * bridged edge set wholesale (see components.ts's own doc comment).
 */
function buildEdgeIndex(edges: readonly Edge[]): Map<number, Map<number, Edge>> {
  const index = new Map<number, Map<number, Edge>>();
  for (const e of edges) {
    if (isSyntheticBridge(e)) continue; // no commit backs it
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    let row = index.get(lo);
    if (!row) index.set(lo, (row = new Map()));
    row.set(hi, e);
  }
  return index;
}

function edgeBetween(index: ReadonlyMap<number, Map<number, Edge>>, i: number, j: number): Edge | undefined {
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return index.get(lo)?.get(hi);
}

/**
 * Summed `edgeWeight` over cross pairs of DISTINCT files, one from each
 * surface — the {@link ConflictPair.coupled} half.
 *
 * Deduplicated by (file id, file id), never by iteration order: when the two
 * surfaces overlap on more than the single file being paired (both tasks
 * tied across the same two files, say), the same unordered file pair can be
 * produced by more than one `(fa, fb)` combination, and counting it twice
 * would inflate the sum for a reason that has nothing to do with the
 * evidence — the pair is still backed by exactly one edge.
 *
 * `classifyPair(fa, fb) !== "candidate"` skips the same noise
 * {@link suppressedSharedFiles} filters `shared` through — a manifest paired
 * cross-task with its own lockfile, or a test file paired with anything, is
 * not evidence of a real conflict either.
 */
function coupledScore(
  surfaceA: readonly string[],
  surfaceB: readonly string[],
  idOf: ReadonlyMap<string, number>,
  edgeIndex: ReadonlyMap<number, Map<number, Edge>>,
): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const fa of surfaceA) {
    for (const fb of surfaceB) {
      if (fa === fb) continue; // the same file is `shared`, not `coupled`
      const ia = idOf.get(fa);
      const ib = idOf.get(fb);
      if (ia === undefined || ib === undefined) continue;
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      const key = `${lo} ${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (classifyPair(fa, fb) !== "candidate") continue;
      const edge = edgeBetween(edgeIndex, ia, ib);
      if (edge === undefined) continue;
      const w = edgeWeight(edge);
      if (w > 0) sum += w;
    }
  }
  return sum;
}

/**
 * Whether every pair of `tasks` decomposes cleanly, over predicted surfaces
 * only — see this module's doc comment for why `predicted` is the sole,
 * permanent mode. `edges`/`files` are the SAME co-change graph
 * `impact`/`drift`/`own` already answer against (`analyze()`'s own return
 * shape), never a second harvest; `tasks` is whatever set the caller
 * resolved — a mission's, a campaign's (which may span more than one
 * mission), or an explicit list — this function has no opinion on which and
 * treats every task identically regardless of its `.mission`/`.campaign`.
 *
 * Every task's surface is computed once (`surfaces`, below) and then read by
 * every pair it participates in — O(tasks) predictions, not O(tasks^2).
 *
 * A pair with neither a shared file nor any surviving cross-file coupling is
 * OMITTED, not reported at a floor of zero: a clean decomposition must
 * report nothing, never the weakest pair the corpus happens to produce.
 *
 * Ranked by `shared.length` first (a literal collision outranks a mere
 * historical correlation), then `coupled`, then `compare` on both task ids —
 * deterministic regardless of `tasks`' own input order.
 *
 * `lexical` is the caller's configured `predictFiles` gate
 * (`octograph.yaml`'s `lexicalConfidenceFloor` / `lexicalRunnerUpMargin`, via
 * `config.ts`'s `lexicalOptions`). Passed through rather than defaulted here:
 * a setting a user wrote in their own config file and that this command
 * silently ignored would be the `--half-life-days` defect `cli.ts` documents,
 * one layer down — and every file in this answer comes out of that gate.
 */
export function conflicts(
  analysis: Analysis,
  edges: Edge[],
  files: readonly string[],
  tasks: readonly BoardTask[],
  lexical: LexicalOptions = {},
): ConflictPair[] {
  const modOf = moduleOfFile(analysis);
  const idOf = new Map(files.map((f, i) => [f, i] as const));
  const edgeIndex = buildEdgeIndex(edges);
  const surfaces = tasks.map((t) => surfaceFor(t, files, modOf, lexical));
  // Memoized across pairs: `isNoiseOnItsOwn` scans the whole corpus, and the
  // same handful of predicted files recur in every pair a task takes part in.
  const noise = new Map<string, boolean>();
  const isNoise = (f: string): boolean => {
    const cached = noise.get(f);
    if (cached !== undefined) return cached;
    const value = isNoiseOnItsOwn(f, files);
    noise.set(f, value);
    return value;
  };

  const pairs: ConflictPair[] = [];
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      const x = surfaces[i];
      const y = surfaces[j];
      if (x === undefined || y === undefined) continue;
      const [left, right] = compare(x.task.id, y.task.id) <= 0 ? [x, y] : [y, x];

      const shared = left.files
        .filter((f) => right.files.includes(f) && !isNoise(f))
        .sort(compare);

      const coupled = coupledScore(left.files, right.files, idOf, edgeIndex);
      if (shared.length === 0 && coupled <= 0) continue;

      const modules = [...left.modules].filter((m) => right.modules.has(m)).sort(compare);

      pairs.push({ a: left.task.id, b: right.task.id, mode: "predicted", shared, coupled, modules });
    }
  }

  pairs.sort(
    (p, q) =>
      q.shared.length - p.shared.length ||
      q.coupled - p.coupled ||
      compare(p.a, q.a) ||
      compare(p.b, q.b),
  );
  return pairs;
}
