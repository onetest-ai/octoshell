/**
 * Task <-> file attribution, in one of exactly TWO modes — never blurred, and
 * never a third. `AttributionMode` has exactly two members on purpose: an
 * earlier draft of the M4 plan proposed a third `inferred` mode that would
 * scan squash-merge commit subjects for task ids (they carry one by
 * convention, e.g. `feat(graph): T3.5 — CLI and the pack bundle (#48)`).
 * Measuring killed that idea — `gh pr list --state merged
 * --json headRefName,mergeCommit` recovers EVERY merged PR's merge SHA
 * permanently, including for branches `gh pr merge --delete-branch` already
 * deleted, so the "recover it from history" problem this campaign's own
 * worklog has (see `.octobots/hooks/work-log.mjs` and
 * `backfill-worklog-sha.mjs` in the pack) is solved as a FACT via the
 * GitHub API, not as a lossy inference from a commit-message convention that
 * has no id for every task (T2.1, on this repo, has none). Do not add a
 * third mode here — see the M4 board-overlay plan's "finding that reshapes
 * this mission" for the measurement.
 *
 *  - `provenance` — the worklog recorded a merge SHA (via the gate's
 *    backfill, see the pack) and that SHA still resolves to a commit in this
 *    repo. Its changed files ARE the task's files, as a fact.
 *  - `predicted` — everything else: no recorded SHA, or one that no longer
 *    resolves (a force-push, a rewritten history — evidence is only good
 *    while it resolves). The lexical predictor that fills this mode in is
 *    Task 3's job, OUT OF SCOPE here; until it lands, a `predicted`
 *    attribution carries no files, but it is still an ANSWER — every board
 *    task gets an entry, never a silent omission.
 */
import { execFileSync } from "node:child_process";
import type { BoardView } from "./board.js";
import { compare } from "./rollup.js";
import type { WorklogEntry } from "./worklog.js";

export type AttributionMode = "provenance" | "predicted";

export interface Attribution {
  task: string;
  files: string[];
  mode: AttributionMode;
}

/**
 * Files changed by `sha` in `repoRoot`, `compare`-sorted, or `null` if `sha`
 * does not resolve to a commit here. `--root` so a SHA that happens to be a
 * repo's very first commit (no parent to diff against) still reports its
 * files instead of the empty diff plain `diff-tree` gives a root commit.
 */
function filesChangedBy(repoRoot: string, sha: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split("\n")
      .filter((f) => f !== "")
      .sort(compare);
  } catch {
    return null; // force-push, rewritten history, or simply not a valid object here
  }
}

/**
 * The most recently recorded SHA for `taskId`, or `null` if none of its
 * worklog entries carries one. A task is logged more than once (`active`,
 * then `done`) and only a post-merge backfill ever adds `mergedSha`, so
 * picking the latest `at` is what "the SHA that is actually current" means —
 * never the array's incidental iteration order.
 */
function latestShaFor(taskId: string, log: WorklogEntry[]): string | null {
  let best: { sha: string; at: string } | null = null;
  for (const e of log) {
    if (e.task !== taskId || e.mergedSha === null) continue;
    if (best === null || compare(e.at, best.at) > 0) best = { sha: e.mergedSha, at: e.at };
  }
  return best === null ? null : best.sha;
}

/**
 * Attributes every task on `board` to the files it touched, one
 * {@link Attribution} per task — so a task with no evidence still appears,
 * labelled `predicted`, rather than being dropped from the output.
 */
export function attribute(repoRoot: string, board: BoardView, log: WorklogEntry[]): Attribution[] {
  return board.tasks.map((task): Attribution => {
    const sha = latestShaFor(task.id, log);
    if (sha !== null) {
      const files = filesChangedBy(repoRoot, sha);
      if (files !== null) return { task: task.id, files, mode: "provenance" };
    }
    return { task: task.id, files: [], mode: "predicted" };
  });
}
