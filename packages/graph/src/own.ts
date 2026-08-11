/**
 * `own [<path>]`: which mission owns a module, and which acceptance
 * criterion a file exists to satisfy — stating the {@link AttributionMode}
 * for every answer, never blurring `provenance` (a recorded merge SHA that
 * still resolves) and `predicted` (the lexical fallback).
 *
 * Reuses `attribution.ts`'s task<->file join for `provenance` verbatim —
 * never a second git call here — and falls back to `lexical.ts`'s
 * `predictFiles` for `predicted`, scored against `candidates`: the same
 * co-change file corpus `impact`/`drift` already answer against (see
 * `cli.ts`'s `analyze(...).files`). Per the M4 plan's "build order" note,
 * `conflicts` (Task 5, out of scope here) shares this task<->surface
 * prediction machinery, which is why it must land after `own` proves it.
 */
import { attribute, type AttributionMode } from "./attribution.js";
import type { BoardTask, BoardView } from "./board.js";
import { predictFiles, tokenize } from "./lexical.js";
import { compare } from "./rollup.js";
import type { WorklogEntry } from "./worklog.js";

export interface OwnAnswer {
  path: string;
  task: string;
  mission: string;
  criterion: string;
  mode: AttributionMode;
}

/**
 * Which of `task`'s acceptance criteria `path` most plausibly exists to
 * satisfy: the criterion sharing the most identifier-shaped tokens with the
 * path, through `lexical.ts`'s own `tokenize` — never a second tokenizer —
 * so this and `predictFiles` can never disagree about what counts as a
 * token. Ties broken by `compare`, never object/array iteration order.
 *
 * `null` only when `criteria` is empty, which a validated board never
 * produces (every task needs at least one acceptance criterion — see
 * `CLAUDE.md`'s board rules) — callers still treat it as "skip this task"
 * rather than crash on a board this module cannot itself validate.
 */
function bestCriterion(criteria: readonly string[], path: string): string | null {
  const pathTokens = new Set(tokenize(path));
  let best: { text: string; score: number } | null = null;
  for (const criterion of criteria) {
    const score = tokenize(criterion).filter((t) => pathTokens.has(t)).length;
    if (best === null || score > best.score || (score === best.score && compare(criterion, best.text) < 0)) {
      best = { text: criterion, score };
    }
  }
  return best === null ? null : best.text;
}

/** `candidates` with `path` folded in, `compare`-sorted — `predictFiles` can
 *  only ever return a file that is IN its candidate list, so a queried path
 *  outside the harvested corpus (a file only ever touched by single-file
 *  commits, say — the same partial-not-total gap `spine.ts`'s
 *  `filesByModule` documents) must still be considered, or `own` would
 *  silently answer "predicted: nothing" for every such file regardless of
 *  how well its criteria actually match. */
function withCandidate(candidates: readonly string[], path: string): string[] {
  return candidates.includes(path) ? [...candidates] : [...candidates, path].sort(compare);
}

/**
 * The files this task owns and their mode, WITHOUT git or a lexical call
 * when `path` narrows to one already known not to match — `path === null`
 * asks for every file the task owns (an inventory), a real `path` asks
 * "does this task own exactly this file".
 */
function filesFor(task: BoardTask, mode: AttributionMode, provenanceFiles: readonly string[], candidates: readonly string[], path: string | null): string[] {
  if (mode === "provenance") {
    return path === null ? [...provenanceFiles] : provenanceFiles.filter((f) => f === path);
  }
  const corpus = path === null ? candidates : withCandidate(candidates, path);
  const predicted = predictFiles(task.criteria, corpus).map((m) => m.file);
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
 */
export function own(
  repoRoot: string,
  board: BoardView,
  log: WorklogEntry[],
  candidates: readonly string[],
  path: string | null,
): OwnAnswer[] {
  const attributions = attribute(repoRoot, board, log);
  const byTask = new Map(board.tasks.map((t) => [t.id, t] as const));

  const answers: OwnAnswer[] = [];
  for (const a of attributions) {
    const task = byTask.get(a.task);
    if (task === undefined) continue; // defensive: attribute() only ever emits ids sourced from board.tasks
    const mission = board.missionOf(task.id);
    if (mission === null) continue; // defensive: same as above

    for (const file of filesFor(task, a.mode, a.files, candidates, path)) {
      const criterion = bestCriterion(task.criteria, file);
      if (criterion === null) continue; // unreachable on a validated board
      answers.push({ path: file, task: task.id, mission, criterion, mode: a.mode });
    }
  }

  answers.sort(
    (x, y) => compare(x.mission, y.mission) || compare(x.task, y.task) || compare(x.path, y.path),
  );
  return answers;
}
