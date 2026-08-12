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
import type { BoardTask, BoardView } from "./board.js";
import { compare } from "./rollup.js";
import type { WorklogEntry } from "./worklog.js";

export type AttributionMode = "provenance" | "predicted";

export interface Attribution {
  task: string;
  files: string[];
  /**
   * Paths the SAME recorded merge (when `mode === "provenance"`) deleted —
   * present in that commit's diff but gone from the tree afterward, and
   * therefore EXCLUDED from {@link files}: a mission cannot own a path that
   * is not there, the same call `own.ts`'s `isRepoFile` guard already makes
   * for a path that never existed at all — a path a merge just removed is
   * "not there" by a different route, and this campaign's recurring defect
   * is treating the two differently. Always `[]` when `mode === "predicted"`
   * — nothing here is git evidence to begin with.
   *
   * Kept as its own field rather than folded into `files` or dropped
   * outright so a caller asking about ONE such path (`own.ts`'s `path !==
   * null` query) can tell "this task never touched it" apart from "this
   * task's own recorded merge touched it, then removed it" — the mislabel
   * `own src/gone.ts` shipped is silence about exactly that difference.
   */
  deletedFiles: string[];
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
 * `filesChangedBy`'s answer, split by whether the merge KEPT the path or
 * REMOVED it. `kept` is what {@link Attribution.files} is built from —
 * `deleted` exists only so a caller can tell "never touched" apart from
 * "touched, then removed by the very commit that would otherwise have
 * claimed it" (see {@link Attribution.deletedFiles}) — never to be re-added
 * to `kept`, at any call site: a mission cannot own a path that is not
 * there, the same rule `own.ts`'s `isRepoFile` guard already applies to a
 * path that never existed at all.
 */
interface ChangedFiles {
  kept: string[];
  deleted: string[];
}

/**
 * Files changed by `sha` in `repoRoot`, split into {@link ChangedFiles.kept}
 * and {@link ChangedFiles.deleted} and each half `compare`-sorted, or `null`
 * if `sha` is not an object name or does not resolve to a commit here.
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
 *
 * `--name-status`, not `--name-only`: the campaign's recurring defect shipped
 * here too, one call away from where it always ships — `own src/gone.ts`
 * answered `provenance`, citing the very commit that DELETED `src/gone.ts`,
 * because `--name-only` lists a deletion exactly like an addition and nothing
 * downstream could tell the two apart. `--name-status -z` interleaves
 * `<status>\0<path>\0` pairs; rename/copy detection (`-M`/`-C`) is
 * deliberately never requested — the same choice `harvest.ts`'s own
 * `--name-only` call makes — so every status here names exactly one path and
 * no record ever carries a second (destination) path to account for.
 */
function filesChangedBy(repoRoot: string, sha: string): ChangedFiles | null {
  if (!OBJECT_NAME.test(sha)) return null;
  try {
    const out = execFileSync(
      "git",
      [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--diff-merges=first-parent",
        "--root",
        sha,
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const tokens = out.split("\0").filter((t) => t !== "");
    const kept = new Set<string>();
    const deleted = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const file = tokens[i + 1];
      if (status === undefined || file === undefined) continue;
      (status.startsWith("D") ? deleted : kept).add(file);
    }
    return { kept: [...kept].sort(compare), deleted: [...deleted].sort(compare) };
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
 * Emits one line of non-fatal diagnostic text — by default to the real
 * process's stderr, exactly like a CLI warning should read. Threaded as an
 * explicit parameter (never a bare `console.error`/`process.stderr.write`
 * inline below) so a caller — a test, or a future CLI layer that wants to
 * fold this into a `CliResult` the way `cli.ts`'s `sinceMismatchWarning`
 * folds its own — can capture it without mocking a global.
 */
export type Warn = (message: string) => void;

/**
 * Exported, not module-private: `worklog.ts` (readWorklog's own missing-field
 * warning) and `own.ts` (its deleted-path warning) reuse this exact default
 * rather than each writing its own `process.stderr.write` — one seam, one
 * real sink, never a second spelling of "how does a warning reach the
 * terminal by default". There is a filed, deliberately-unfixed bug about this
 * default writing to stderr directly rather than folding into a `CliResult`
 * (see `.octobots/…/attribute-writes-to-stderr-directly-bypassing-runc`,
 * closed as "not a defect" — `runCli` is a testability seam, not a contract
 * an in-process caller depends on); that closure stands, and every consumer
 * of this default inherits it unchanged rather than working around it here.
 */
export const defaultWarn: Warn = (message) => {
  process.stderr.write(message);
};

/**
 * The trailing path segment of a `BoardTask.campaign` entity id
 * (`folder:campaigns/<slug>` — see `@octoshell/board`'s `createCampaign`) —
 * the campaign's slug, and nothing else. Used as text to search for inside a
 * branch name, never re-derived from a name/title, because the slug is
 * exactly what a conventional branch (`feat/<slug>-m3-t1`) actually embeds.
 */
function campaignSlug(campaignId: string): string {
  const idx = campaignId.lastIndexOf("/");
  return idx === -1 ? campaignId : campaignId.slice(idx + 1);
}

/**
 * Narrows `candidates` (board tasks that all share one ambiguous short id) to
 * the single one `branch`'s text names, or `[]` when zero or more than one
 * campaign slug matches — an ambiguous branch is not a tiebreaker, it is
 * still ambiguous, and guessing between two matches would be exactly the
 * silent-wrong-attribution failure this module exists to avoid.
 *
 * "Which campaign slugs does this branch name CONTAIN", deliberately not a
 * rigid `feat/<slug>-m<n>-t<k>` parse: a mission may declare a
 * non-conventional branch name (see `mission-completion-gate`'s
 * `tokenomics.branches`), and a substring search is the only shape that
 * degrades gracefully to "no match" instead of throwing on one.
 */
function disambiguateByBranch(candidates: readonly BoardTask[], branch: string | null): BoardTask[] {
  if (branch === null) return [];
  const matches = candidates.filter((t) => branch.includes(campaignSlug(t.campaign)));
  return matches.length === 1 ? matches : [];
}

/**
 * Resolves one worklog entry's `task` field to the single board task it
 * names, or `null` when it names none or more than one — `byId` first (a
 * task's own full board id, which nothing writes today but is unambiguous by
 * construction the day `work-log.mjs` learns to), else every task sharing
 * that SHORT id via `byShortId`, narrowed further by
 * {@link disambiguateByBranch} when more than one shares it.
 */
function resolveEntryTask(
  entry: WorklogEntry,
  byId: ReadonlyMap<string, BoardTask>,
  byShortId: ReadonlyMap<string, readonly BoardTask[]>,
): readonly BoardTask[] {
  if (entry.task === null) return [];
  const direct = byId.get(entry.task);
  if (direct !== undefined) return [direct];
  const candidates = byShortId.get(entry.task) ?? [];
  if (candidates.length <= 1) return candidates;
  return disambiguateByBranch(candidates, entry.branch);
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
 * T3.5 as a recorded fact. The worklog's OWN `branch` field disambiguates
 * this: its text carries the campaign slug (`feat/octograph-…-m3-t1`) even
 * once the branch itself is long deleted as a git ref — a dead ref is still
 * usable as an identifier — so an ambiguous short id resolves through
 * {@link disambiguateByBranch} whenever exactly one candidate's campaign
 * slug appears in the branch text.
 *
 * When it still cannot resolve, the entry is not silently dropped: `warn`
 * (real stderr by default) says so, for every entry whose `mergedSha`
 * actually resolves in this repo (an unresolvable one already falls through
 * to `predicted` for an unrelated reason, and warning about it too would
 * just be noise). Both ways an entry fails to join are warned, because both
 * discard the same evidence:
 *
 *  - the short id names MORE THAN ONE task and the branch could not narrow
 *    it — the warning names the ambiguous id and the candidates;
 *  - the short id names NO task on this board — a task renamed out of the
 *    `T<m>.<n>` notation `work-log.mjs` records, or deleted outright. This
 *    half shipped silent while the ambiguous half warned, which left the
 *    hole the warning was added to close still open on the commoner of the
 *    two paths (a board is renamed far more often than it grows a duplicate
 *    short id).
 *
 * The task itself
 * still answers `predicted` either way — {@link AttributionMode} keeps
 * exactly two members — but a reader watching stderr can tell "provenance
 * existed but could not be joined" apart from "no provenance existed at
 * all", which the mode alone cannot say.
 *
 * **Latest-wins falls back, and says so.** A task can log more than one
 * resolved entry (`active`, then `done` — see the fixture below), and only
 * the newest was ever tried: if ITS sha no longer resolves, or resolves to
 * an empty first-parent diff, the task fell to `predicted` even when an
 * OLDER entry's sha would have resolved fine. That discarded real,
 * still-usable evidence for the same reason the two cases above do — it was
 * there and the code never looked. Every entry `resolveEntryTask` joined to
 * this task is kept (not just the newest), newest-first, and each is tried
 * in turn until one resolves to a non-empty {@link ChangedFiles.kept}. Falling
 * back rather than giving up matches every other `predicted`-avoidance
 * choice in this function; falling back SILENTLY would not — a reader
 * watching stderr can tell "the freshest recorded evidence didn't pan out
 * (force-push, empty diff, all-deletions) and this answer rests on an OLDER
 * commit instead" apart from "the freshest evidence is what this answer
 * rests on", which the mode alone cannot say either.
 */
export function attribute(
  repoRoot: string,
  board: BoardView,
  log: WorklogEntry[],
  warn: Warn = defaultWarn,
): Attribution[] {
  const byId = new Map(board.tasks.map((t) => [t.id, t] as const));
  const byShortId = new Map<string, BoardTask[]>();
  for (const t of board.tasks) {
    const short = SHORT_ID.exec(t.name)?.[1];
    if (short === undefined) continue;
    const existing = byShortId.get(short);
    if (existing !== undefined) existing.push(t);
    else byShortId.set(short, [t]);
  }

  // EVERY resolved {sha, at} recorded for each task, keyed by `BoardTask.id`
  // — never blended across an ambiguous short id, since only an entry
  // `resolveEntryTask` narrowed to exactly one task reaches here. Not just
  // the newest: see this function's doc comment on why the newest alone is
  // not enough to answer from.
  const evidence = new Map<string, { sha: string; at: string }[]>();

  for (const entry of log) {
    if (entry.task === null || entry.mergedSha === null) continue;
    const resolved = resolveEntryTask(entry, byId, byShortId);
    if (resolved.length !== 1) {
      const candidates = byShortId.get(entry.task) ?? [];
      // Gated on the SHA still resolving, for BOTH branches below: an entry
      // whose evidence is already gone falls through to `predicted` for its
      // own stated reason, and warning about it too would bury the case that
      // means "evidence exists and was lost" under every case that means
      // "there was never any evidence".
      if (filesChangedBy(repoRoot, entry.mergedSha) !== null) {
        if (candidates.length > 1) {
          // The branch could not narrow a short id more than one task shares.
          const names = candidates.map((t) => t.id).sort(compare).join(", ");
          warn(
            `octograph: worklog entry for task "${entry.task}" (branch: ` +
              `${entry.branch ?? "(none)"}) matches ${candidates.length} board tasks and could not ` +
              `be resolved to exactly one — candidates: ${names}\n`,
          );
        } else {
          // Zero candidates: the id names nothing on this board. A task
          // renamed out of the `T<m>.<n>` notation `work-log.mjs` recorded it
          // under, or deleted outright, leaves exactly this — and it is the
          // same failure as the ambiguous case, not a lesser one. Real,
          // still-resolvable evidence is being discarded, and the mode alone
          // cannot say so: `predicted` reads identically whether provenance
          // never existed or existed and could not be joined.
          warn(
            `octograph: worklog entry for task "${entry.task}" (branch: ` +
              `${entry.branch ?? "(none)"}) carries a merge SHA that still resolves here but ` +
              `names no task on this board — its provenance is dropped\n`,
          );
        }
      }
      continue;
    }
    const task = resolved[0];
    if (task === undefined) continue; // unreachable: guarded by resolved.length !== 1 above
    const rec = { sha: entry.mergedSha, at: entry.at };
    const existing = evidence.get(task.id);
    if (existing !== undefined) existing.push(rec);
    else evidence.set(task.id, [rec]);
  }

  return board.tasks.map((task): Attribution => {
    const list = evidence.get(task.id);
    if (list !== undefined) {
      // Newest first — a stable sort, so two entries logged at the exact
      // same `at` keep the order they arrived in the log, same as the
      // single-entry `latest` map this replaced.
      const sorted = [...list].sort((a, b) => compare(b.at, a.at));
      for (let i = 0; i < sorted.length; i++) {
        const rec = sorted[i];
        if (rec === undefined) continue; // unreachable: i < sorted.length
        const changed = filesChangedBy(repoRoot, rec.sha);
        if (changed === null || changed.kept.length === 0) continue;
        if (i > 0) {
          // The newest entry(ies) didn't pan out and an OLDER one did — say
          // so, rather than silently answering as if the newest evidence had
          // simply never existed. See this function's doc comment.
          const skipped = sorted
            .slice(0, i)
            .map((r) => `${r.sha} (at ${r.at})`)
            .join(", ");
          warn(
            `octograph: task "${task.id}" — newer worklog evidence could not be used ` +
              `(${skipped}); falling back to older evidence: ${rec.sha} (at ${rec.at})\n`,
          );
        }
        return { task: task.id, files: changed.kept, deletedFiles: changed.deleted, mode: "provenance" };
      }
    }
    return { task: task.id, files: [], deletedFiles: [], mode: "predicted" };
  });
}
