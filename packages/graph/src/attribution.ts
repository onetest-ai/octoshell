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
 * A git object name and nothing else. The recorded SHA is read out of
 * `worklog.jsonl` — a file the gate COMMITS, so its contents arrive from the
 * repo rather than from this process — and it is about to become an argv
 * element of a `git` call. `git diff-tree --output=<file>` is a real
 * arbitrary-write primitive (verified 2026-08-11: it created the named file),
 * so a `merged_sha` of `--output=…` would reach it as an option, not as a
 * revision. Anything that is not a hex object name is therefore not a SHA,
 * is not evidence, and never gets spawned: it falls through to `predicted`
 * exactly like a SHA that no longer resolves. 40 hex for sha1, 64 for a
 * sha256 repo; the lower bound covers a hand-abbreviated entry.
 */
const OBJECT_NAME = /^[0-9a-f]{7,64}$/;

/**
 * Files changed by `sha` in `repoRoot`, `compare`-sorted, or `null` if `sha`
 * is not an object name or does not resolve to a commit here.
 *
 * `-z`, not a `\n` split. Without it git applies `core.quotePath` and hands
 * back C-quoted paths for anything non-ASCII — `src/résumé.ts` arrives as
 * `"src/r\303\251sum\303\251.ts"`, quotes and all — which is not a path that
 * exists on disk and would never match the node `harvest` (which passes `-z`
 * for this exact reason) put in the graph. A `provenance` label on a path
 * that is a rendering artefact rather than a file is this campaign's
 * recurring defect, not a cosmetic one.
 *
 * `--diff-merges=first-parent`, because the recorded SHA is a MERGE commit
 * whenever the repo merges PRs instead of squashing them — `gh`'s
 * `mergeCommit.oid` is the merge either way — and plain `diff-tree` reports
 * NOTHING for a multi-parent commit (verified 2026-08-11). That silently
 * yielded an empty file list wearing a `provenance` label: a recorded-fact
 * claim backed by zero files. First-parent is what "the files this PR
 * brought in" means.
 *
 * `--root` so a SHA that happens to be a repo's very first commit (no parent
 * to diff against) still reports its files instead of the empty diff plain
 * `diff-tree` gives a root commit.
 */
function filesChangedBy(repoRoot: string, sha: string): string[] | null {
  if (!OBJECT_NAME.test(sha)) return null;
  try {
    const out = execFileSync(
      "git",
      [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "--diff-merges=first-parent",
        "--root",
        sha,
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return [...new Set(out.split("\0").filter((f) => f !== ""))].sort(compare);
  } catch {
    return null; // force-push, rewritten history, or simply not a valid object here
  }
}

/**
 * The short board-notation id at the head of a task's NAME — `T4.2` out of
 * `"T4.2 - Merge-SHA capture at the gate"` — or `null` when a task's name
 * does not open with one.
 *
 * This is the join key, and getting it wrong is how this whole module
 * silently computed nothing. `BoardTask.id` is `@octoshell/board`'s entity
 * id, a FOLDER PATH
 * (`folder:campaigns/octograph-…/missions/m4-…/tasks/t4-2-…`), while the
 * pack's `hooks/work-log.mjs` records the short id it pulls off the
 * `set-status.js` title with `/^(T\d+\.\d+)\b/` and nothing else — it never
 * sees a folder id. Comparing `WorklogEntry.task` to `BoardTask.id` compares
 * two id namespaces that can never be equal: measured on this repo
 * (2026-08-11), 52 board tasks against 18 worklog entries produced ZERO
 * provenance rows.
 *
 * The regex mirrors work-log.mjs's, deliberately and unavoidably: that
 * script ships dependency-free into workspaces with no `node_modules`, so it
 * cannot import this — the same necessary duplication `entity-io.mjs`
 * carries for the board schema. Change one and change the other.
 */
const SHORT_ID = /^(T\d+\.\d+)\b/;

/**
 * The most recently recorded SHA for a task, or `null` if no worklog entry
 * carries one for it. A task is logged more than once (`active`, then
 * `done`) and only a post-merge backfill ever adds `mergedSha`, so picking
 * the latest `at` is what "the SHA that is actually current" means — never
 * the array's incidental iteration order.
 *
 * `keys` are every id this task answers to: its full board id first (which
 * nothing writes today, but is unambiguous by construction the day
 * work-log.mjs learns to), then its short id.
 */
function latestShaFor(keys: readonly string[], log: WorklogEntry[]): string | null {
  let best: { sha: string; at: string } | null = null;
  for (const e of log) {
    if (e.task === null || e.mergedSha === null || !keys.includes(e.task)) continue;
    if (best === null || compare(e.at, best.at) > 0) best = { sha: e.mergedSha, at: e.at };
  }
  return best === null ? null : best.sha;
}

/**
 * Attributes every task on `board` to the files it touched, one
 * {@link Attribution} per task — so a task with no evidence still appears,
 * labelled `predicted`, rather than being dropped from the output.
 *
 * `mode: "provenance"` implies `files.length > 0`, and that is the point of
 * the label: it says "these files came from a recorded merge". A resolvable
 * SHA whose first-parent diff is EMPTY (an empty commit, or a re-merge of
 * changes already on the target branch) proves nothing about which files the
 * task owns, so it is not dressed up as a fact — it falls through to
 * `predicted`, where the lexical layer can still answer, instead of
 * permanently asserting that this task owns nothing.
 *
 * A short id is only evidence while it names ONE task. `T3.5` is unique
 * within a campaign and nowhere else — this repo's board carries 14 short
 * ids shared across two or three campaigns (2026-08-11), so joining on it
 * alone would hand `octograph`'s T3.5 files to `octobots-pack-ergonomics`'s
 * T3.5 as a recorded fact. An ambiguous short id is therefore evidence for
 * NEITHER task: both fall through to `predicted`, where the lexical layer
 * answers and nobody is told a merge they did not make is theirs. The fix
 * that removes the ambiguity is upstream — work-log.mjs recording the task's
 * full board id — not a tiebreaker guessed from a branch name here.
 */
export function attribute(repoRoot: string, board: BoardView, log: WorklogEntry[]): Attribution[] {
  const shareShortId = new Map<string, number>();
  for (const t of board.tasks) {
    const short = SHORT_ID.exec(t.name)?.[1];
    if (short !== undefined) shareShortId.set(short, (shareShortId.get(short) ?? 0) + 1);
  }

  return board.tasks.map((task): Attribution => {
    const short = SHORT_ID.exec(task.name)?.[1];
    const keys = short !== undefined && shareShortId.get(short) === 1 ? [task.id, short] : [task.id];
    const sha = latestShaFor(keys, log);
    if (sha !== null) {
      const files = filesChangedBy(repoRoot, sha);
      if (files !== null && files.length > 0) return { task: task.id, files, mode: "provenance" };
    }
    return { task: task.id, files: [], mode: "predicted" };
  });
}
