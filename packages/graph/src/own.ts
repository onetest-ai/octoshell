/**
 * `own [<path>]`: which mission owns a module, and which acceptance
 * criterion a file exists to satisfy — stating the mode of EACH of those two
 * answers separately, never blurring `provenance` (a recorded merge SHA that
 * still resolves) and `predicted` (the lexical fallback).
 *
 * Two answers, two labels ({@link OwnAnswer.mode} and
 * {@link OwnAnswer.criterionMode}), because they rest on different evidence:
 * a merge SHA proves which FILES a task touched and says nothing whatever
 * about which criterion any of them serves. One shared label let a lexical
 * guess ride out under a `provenance` badge.
 *
 * Reuses `attribution.ts`'s task<->file join for `provenance` verbatim —
 * never a second git call here — and falls back to `lexical.ts`'s
 * `predictFiles` for `predicted`, scored against `candidates`: the same
 * co-change file corpus `impact`/`drift` already answer against (see
 * `cli.ts`'s `analyze(...).files`). Per the M4 plan's "build order" note,
 * `conflicts` (Task 5, out of scope here) shares this task<->surface
 * prediction machinery, which is why it must land after `own` proves it.
 */
import { statSync } from "node:fs";
import { attribute, type AttributionMode } from "./attribution.js";
import type { BoardTask, BoardView } from "./board.js";
import { predictFiles, tokenize, type LexicalOptions } from "./lexical.js";
import { insideRepo } from "./paths.js";
import { compare } from "./rollup.js";
import type { WorklogEntry } from "./worklog.js";

export interface OwnAnswer {
  path: string;
  task: string;
  mission: string;
  /** The acceptance criterion this file most plausibly exists to satisfy, or
   *  `null` when nothing in the path's own words singles one out — see
   *  {@link bestCriterion}. `null` is an ANSWER ("this file's owner is
   *  known, which criterion it serves is not"), never a dropped row: the
   *  ownership half of the row can be a recorded fact even when the
   *  criterion half has no evidence at all. */
  criterion: string | null;
  /** How the OWNERSHIP half of this row (which task/mission the file belongs
   *  to) was reached — `attribute()`'s mode, verbatim. It says nothing about
   *  {@link criterion}; that is what {@link criterionMode} is for. */
  mode: AttributionMode;
  /**
   * How the CRITERION half was reached: `"predicted"` whenever a criterion is
   * named, `null` when none is — and **never `"provenance"`**, which is why
   * this is not an {@link AttributionMode}.
   *
   * A merge SHA is evidence about FILES (`git diff-tree` lists them) and about
   * nothing else. No commit, hook or worklog entry anywhere records which
   * acceptance criterion a file was written to satisfy, so every criterion
   * this module names is a lexical guess — and stamping one with the
   * ownership row's `provenance` label is this campaign's recurring defect in
   * its purest form. It shipped here: `own packages/graph/src/louvain.ts`
   * answered `(provenance) criterion: autoResolution returns 1.0 below 2
   * nodes…`, a criterion sharing not one token with that path, picked purely
   * because it sorted first among four zero-scoring ties.
   */
  criterionMode: "predicted" | null;
}

/**
 * Which of `task`'s acceptance criteria `path` most plausibly exists to
 * satisfy: the criterion sharing the most identifier-shaped tokens with the
 * path, through `lexical.ts`'s own `tokenize` — never a second tokenizer —
 * so this and `predictFiles` can never disagree about what counts as a token.
 *
 * `null` — "no answer" — in three cases, all of them the same rule
 * `predictFiles` already applies to files, applied here to criteria:
 *
 *  - **No criteria.** A validated board never produces this (every task needs
 *    an acceptance criterion), but this module cannot validate the board it
 *    is handed.
 *  - **A top score of zero.** The criterion shares NOT ONE distinctive token
 *    with the path: there is no weak evidence to weigh, there is no evidence.
 *    `lexical.ts` spells the same rule for files ("a zero score is never an
 *    answer, at any threshold") and returning the alphabetically-first
 *    zero-scoring criterion instead is what made this function's first
 *    version emit `louvain.ts … criterion: autoResolution returns 1.0…`.
 *  - **A tie at the top.** Two criteria the path's words support equally are
 *    a coin flip, not a prediction — the same argument `RUNNER_UP_MARGIN`
 *    makes for files. Measured on this repo: `packages/graph/src/
 *    components.ts` scores 1 for BOTH "two isolated components become one
 *    after bridging" (via `components`) and "an already-connected graph gains
 *    no edges" (via `graph`, from the package directory); breaking that tie by
 *    `compare` named the second — the one the path does not describe.
 *
 * Deterministic without a tie-break: a tie yields `null` whatever order the
 * criteria arrive in, and a strict winner is the same criterion in any order.
 *
 * Not `predictFiles` transposed (criteria as documents, path as query),
 * tempting as that is: its `idf` is `ln(N/df)` over the candidate corpus, and
 * a task with ONE criterion — the common case on this board — makes `N === 1`,
 * so every token scores `ln(1/1) === 0` and every single-criterion task would
 * answer `null` by arithmetic rather than by evidence.
 */
function bestCriterion(criteria: readonly string[], path: string): string | null {
  const pathTokens = new Set(tokenize(path));
  let top: { text: string; score: number } | null = null;
  let tied = false;
  for (const criterion of criteria) {
    const score = tokenize(criterion).filter((t) => pathTokens.has(t)).length;
    if (top === null || score > top.score) {
      top = { text: criterion, score };
      tied = false;
    } else if (score === top.score) {
      tied = true;
    }
  }
  if (top === null || top.score === 0 || tied) return null;
  return top.text;
}

/** Whether `path` names a file that actually exists in this checkout, through
 *  the same `insideRepo` every other repo-content path in this package is
 *  resolved by — so a `..`-escaping or symlink-escaping argument is not
 *  stat'd outside the repo, and a directory (`own src/`) is not mistaken for
 *  a file. */
function isRepoFile(repoRoot: string, path: string): boolean {
  const abs = insideRepo(repoRoot, path);
  if (abs === null) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** `candidates` with `path` folded in, `compare`-sorted — `predictFiles` can
 *  only ever return a file that is IN its candidate list, so a queried path
 *  outside the harvested corpus (a file only ever touched by single-file
 *  commits, say — the same partial-not-total gap `spine.ts`'s
 *  `filesByModule` documents) must still be considered, or `own` would
 *  silently answer "predicted: nothing" for every such file regardless of
 *  how well its criteria actually match.
 *
 *  Folded in only if it is a REAL FILE, though. The corpus is otherwise
 *  entirely repo content, and adding an argument string to it makes `own`
 *  answer about a path that does not exist: `own
 *  src/jaccard/empty-sets-score-nan.ts` — a path invented out of T1.6's own
 *  criteria wording, matching nothing in this repo — answered "owned by
 *  m1-co-change-engine / t1-6 (predicted)". A mission cannot own a file that
 *  is not there, and a caller cannot tell that answer apart from a real one. */
function withCandidate(repoRoot: string, candidates: readonly string[], path: string): string[] {
  if (candidates.includes(path)) return [...candidates];
  if (!isRepoFile(repoRoot, path)) return [...candidates];
  return [...candidates, path].sort(compare);
}

/**
 * The files this task owns and their mode, WITHOUT git or a lexical call
 * when `path` narrows to one already known not to match — `path === null`
 * asks for every file the task owns (an inventory), a real `path` asks
 * "does this task own exactly this file".
 */
function filesFor(
  repoRoot: string,
  task: BoardTask,
  mode: AttributionMode,
  provenanceFiles: readonly string[],
  candidates: readonly string[],
  path: string | null,
  lexical: LexicalOptions,
): string[] {
  if (mode === "provenance") {
    return path === null ? [...provenanceFiles] : provenanceFiles.filter((f) => f === path);
  }
  const corpus = path === null ? candidates : withCandidate(repoRoot, candidates, path);
  const predicted = predictFiles(task.criteria, corpus, lexical).map((m) => m.file);
  return path === null ? predicted : predicted.filter((f) => f === path);
}

/**
 * Answers "which mission owns this file, and which criterion does it exist
 * to satisfy" — one {@link OwnAnswer} per (task, file) pair a task owns,
 * `path === null` asking the same question of every file any task owns.
 *
 * `board`/`log` are read once by the caller (never a second board or
 * worklog parse in here — see `attribution.ts`'s doc comment on why a
 * second spelling of the board schema is the defect this whole overlay
 * exists to stop repeating). `candidates` is the repo's own co-change file
 * corpus, the SAME universe `predictFiles`'s calibration was measured
 * against.
 *
 * `lexical` is the caller's configured `predictFiles` gate — see
 * `config.ts`'s `lexicalOptions` for why it is threaded through rather than
 * defaulted here (both `octograph.yaml` keys were inert until it was).
 */
export function own(
  repoRoot: string,
  board: BoardView,
  log: WorklogEntry[],
  candidates: readonly string[],
  path: string | null,
  lexical: LexicalOptions = {},
): OwnAnswer[] {
  const attributions = attribute(repoRoot, board, log);
  const byTask = new Map(board.tasks.map((t) => [t.id, t] as const));

  const answers: OwnAnswer[] = [];
  for (const a of attributions) {
    const task = byTask.get(a.task);
    if (task === undefined) continue; // defensive: attribute() only ever emits ids sourced from board.tasks
    const mission = board.missionOf(task.id);
    if (mission === null) continue; // defensive: same as above

    for (const file of filesFor(repoRoot, task, a.mode, a.files, candidates, path, lexical)) {
      const criterion = bestCriterion(task.criteria, file);
      answers.push({
        path: file,
        task: task.id,
        mission,
        criterion,
        mode: a.mode,
        // Derived from whether a criterion was named, never from `a.mode`:
        // the two halves of this row are reached by two different kinds of
        // evidence and are labelled separately (see OwnAnswer.criterionMode).
        criterionMode: criterion === null ? null : "predicted",
      });
    }
  }

  answers.sort(
    (x, y) => compare(x.mission, y.mission) || compare(x.task, y.task) || compare(x.path, y.path),
  );
  return answers;
}
