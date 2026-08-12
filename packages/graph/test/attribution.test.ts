import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createCampaign, createMission, createTask } from "@octoshell/board";
import { attribute } from "../src/attribution.js";
import { readBoard, type BoardView } from "../src/board.js";
import type { WorklogEntry } from "../src/worklog.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function gitIn(root: string) {
  return (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

/**
 * A repo that is BOTH a git repository and an Octobots board. `board.test.ts`'s
 * board-only fixture never `git init`s, and `fixtures/repo.ts`'s `buildRepo`
 * never writes a board — attribution needs both at once, since it resolves a
 * worklog SHA against real commits *and* reads task ids off the board.
 */
function repoWithBoardAndGit(): { root: string; octobotsDir: string; git: (args: string[]) => string } {
  const root = mkdtempClean("octograph-attribution-");
  const git = gitIn(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  const octobotsDir = join(root, ".octobots");
  mkdirSync(octobotsDir, { recursive: true });
  return { root, octobotsDir, git };
}

/** Writes `files`, commits them, and returns the new commit's SHA. */
function commit(root: string, git: (args: string[]) => string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "test commit"]);
  return git(["rev-parse", "HEAD"]).trim();
}

/** `readBoard`, asserting it found one — never a `!` non-null assertion. */
function requireBoard(root: string): BoardView {
  const board = readBoard(root);
  expect(board).not.toBeNull();
  if (board === null) throw new Error("unreachable: asserted above");
  return board;
}

const entry = (overrides: Partial<WorklogEntry>): WorklogEntry => ({
  sessionId: "s1",
  task: null,
  mission: null,
  branch: null,
  mergedSha: null,
  at: "2026-08-10T00:00:00.000Z",
  ...overrides,
});

describe("attribute", () => {
  it("attributes a task via its recorded merge SHA's changed files, labelled provenance", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" }); // an earlier, unrelated commit
    const sha = commit(root, git, { "src/auth.ts": "export {}\n", "src/auth.test.ts": "test\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    expect(attribute(root, board, log)).toEqual([
      { task: task.id, files: ["src/auth.test.ts", "src/auth.ts"], deletedFiles: [], mode: "provenance" },
    ]);
  });

  it("falls through to predicted, without throwing, when the recorded SHA no longer resolves in this repo", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    // A syntactically valid SHA that names no object in this repo — the
    // shape a force-push or a rewritten history leaves behind.
    const goneSha = "0123456789abcdef0123456789abcdef01234567";
    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: goneSha })];

    expect(() => attribute(root, board, log)).not.toThrow();
    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: [], deletedFiles: [], mode: "predicted" }]);
  });

  it("labels a task with no recorded SHA predicted rather than omitting it", () => {
    const { root, octobotsDir } = repoWithBoardAndGit();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    expect(attribute(root, board, [])).toEqual([{ task: task.id, files: [], deletedFiles: [], mode: "predicted" }]);
  });

  /**
   * The shape `hooks/work-log.mjs` ACTUALLY writes: `"task":"T1.1"`, the
   * short id it pulls off the `set-status.js` title — never
   * `BoardTask.id`, which is `@octoshell/board`'s folder-path entity id
   * (`folder:campaigns/…/tasks/t1-1-…`). Every other test in this file
   * builds its worklog from `task.id`, which makes the join true by
   * construction and hid the fact that on real data the two id namespaces
   * never meet: 52 board tasks against this repo's 18 worklog entries
   * produced ZERO provenance rows.
   */
  it("joins the short task id work-log.mjs actually records, not just the board's folder id", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);
    expect(task.id).not.toBe("T1.1"); // the two namespaces really are different

    const log = [entry({ task: "T1.1", branch: "feat/x-t1", mergedSha: sha })];
    expect(attribute(root, board, log)).toEqual([
      { task: task.id, files: ["src/auth.ts"], deletedFiles: [], mode: "provenance" },
    ]);
  });

  /**
   * A short id is unique within a campaign and nowhere else — this repo's
   * board shares 14 of them across campaigns. Attributing one campaign's
   * `T1.1` merge to another campaign's `T1.1` would be a wrong answer
   * wearing the `provenance` label, which is worse than no answer — and here
   * the branch (`feat/x-t1`) names NEITHER campaign's slug, so there is
   * nothing to disambiguate with either: the entry stays genuinely
   * ambiguous, which is exactly when `warn` must fire (never dropped
   * silently, see the dedicated ambiguity tests below).
   */
  it("refuses provenance for a short id that names more than one task on the board", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n" });

    const first = createCampaign(octobotsDir, { name: "Q3" });
    const firstMission = createMission(octobotsDir, first.id, { title: "M1 - Auth" });
    const a = createTask(octobotsDir, firstMission.id, { name: "T1.1 - JWT" });
    const second = createCampaign(octobotsDir, { name: "Q4" });
    const secondMission = createMission(octobotsDir, second.id, { title: "M1 - Billing" });
    const b = createTask(octobotsDir, secondMission.id, { name: "T1.1 - Invoices" });
    const board = requireBoard(root);

    const log = [entry({ task: "T1.1", branch: "feat/x-t1", mergedSha: sha })];
    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));
    expect(rows.map((r) => r.mode)).toEqual(["predicted", "predicted"]);
    expect(new Set(rows.map((r) => r.task))).toEqual(new Set([a.id, b.id]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("T1.1");

    // …and the ambiguity is what withheld it: the same log against a board
    // where only one T1.1 exists does attribute.
    const soloBoard: BoardView = { ...board, tasks: board.tasks.filter((t) => t.id === a.id) };
    expect(attribute(root, soloBoard, log)).toEqual([
      { task: a.id, files: ["src/auth.ts"], deletedFiles: [], mode: "provenance" },
    ]);
  });

  /**
   * The bug this whole disambiguation exists to fix: `T3.1` names a task in
   * BOTH `octograph-code-architecture-graph` and `octobots-pack-ergonomics`
   * on the real board (measured 2026-08-11), and the worklog's own `branch`
   * field carries the campaign slug even after the branch is long deleted as
   * a git ref. This test fails on pre-fix code — the old join dropped BOTH
   * tasks to `predicted` the moment the short id was ambiguous, regardless
   * of what the branch said.
   */
  it("disambiguates an ambiguous short id using the campaign slug embedded in the branch name", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/drift.ts": "export {}\n" });

    const graph = createCampaign(octobotsDir, { name: "Octograph Code Architecture Graph" });
    const graphMission = createMission(octobotsDir, graph.id, { title: "M3 - Drift" });
    const graphTask = createTask(octobotsDir, graphMission.id, { name: "T3.1 - Noise floor and drift" });

    const pack = createCampaign(octobotsDir, { name: "Octobots Pack Ergonomics" });
    const packMission = createMission(octobotsDir, pack.id, { title: "M3 - Schema" });
    const packTask = createTask(octobotsDir, packMission.id, { name: "T3.1 - entity-schema.ts" });

    const board = requireBoard(root);
    const log = [
      entry({
        task: "T3.1",
        branch: "feat/octograph-code-architecture-graph-m3-t1",
        mergedSha: sha,
      }),
    ];

    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));
    expect(rows).toEqual(
      expect.arrayContaining([
        { task: graphTask.id, files: ["src/drift.ts"], deletedFiles: [], mode: "provenance" },
        { task: packTask.id, files: [], deletedFiles: [], mode: "predicted" },
      ]),
    );
    expect(rows).toHaveLength(2);
    // Resolved cleanly — nothing ambiguous left to warn about.
    expect(warnings).toEqual([]);
  });

  /**
   * A branch matching NEITHER candidate campaign's slug must not vanish: the
   * SHA is real and resolvable, and dropping it silently would look exactly
   * like "this task has no provenance at all" — the distinction the mode
   * labels exist to preserve. Fails on pre-fix code because that code has no
   * warning channel at all.
   */
  it("warns rather than silently dropping when the branch names no candidate campaign", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/shared.ts": "export {}\n" });

    const first = createCampaign(octobotsDir, { name: "Alpha" });
    const firstMission = createMission(octobotsDir, first.id, { title: "M2 - Onboarding" });
    createTask(octobotsDir, firstMission.id, { name: "T2.1 - Sign-up" });
    const second = createCampaign(octobotsDir, { name: "Beta" });
    const secondMission = createMission(octobotsDir, second.id, { title: "M2 - Billing" });
    createTask(octobotsDir, secondMission.id, { name: "T2.1 - Invoices" });
    const board = requireBoard(root);

    const log = [entry({ task: "T2.1", branch: "feat/unrelated-cleanup", mergedSha: sha })];
    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));

    expect(rows.map((r) => r.mode)).toEqual(["predicted", "predicted"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("T2.1");
    expect(warnings[0]).toContain("could not be resolved");
  });

  /**
   * A branch that names MORE THAN ONE candidate campaign is exactly as
   * unresolvable as one naming none — a substring match is not a rank, so
   * two matches is still ambiguous, still warned, never guessed.
   */
  it("warns rather than guessing when the branch names more than one candidate campaign", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/shared.ts": "export {}\n" });

    const first = createCampaign(octobotsDir, { name: "Alpha" });
    const firstMission = createMission(octobotsDir, first.id, { title: "M2 - Onboarding" });
    createTask(octobotsDir, firstMission.id, { name: "T2.1 - Sign-up" });
    const second = createCampaign(octobotsDir, { name: "Alpha Beta" });
    const secondMission = createMission(octobotsDir, second.id, { title: "M2 - Billing" });
    createTask(octobotsDir, secondMission.id, { name: "T2.1 - Invoices" });
    const board = requireBoard(root);

    // Contains both "alpha" and "alpha-beta" — two slugs, not one.
    const log = [entry({ task: "T2.1", branch: "feat/alpha-beta-migration", mergedSha: sha })];
    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));

    expect(rows.map((r) => r.mode)).toEqual(["predicted", "predicted"]);
    expect(warnings).toHaveLength(1);
  });

  /**
   * The non-regression case: a short id unique on the whole board must keep
   * joining exactly as it did before this fix, branch text or no — the
   * ambiguity machinery must never engage for a task nothing else shares an
   * id with.
   */
  it("still joins a genuinely unique short id straight through, unaffected by branch disambiguation", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/unique.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Solo" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M5 - Only" });
    const task = createTask(octobotsDir, mission.id, { name: "T5.1 - The only one" });
    const board = requireBoard(root);

    // A branch that names no campaign at all — irrelevant here, since a
    // unique short id never needs the branch to resolve.
    const log = [entry({ task: "T5.1", branch: "feat/completely-unrelated", mergedSha: sha })];
    const warnings: string[] = [];
    expect(attribute(root, board, log, (m) => warnings.push(m))).toEqual([
      { task: task.id, files: ["src/unique.ts"], deletedFiles: [], mode: "provenance" },
    ]);
    expect(warnings).toEqual([]);
  });

  /**
   * The sibling of the ambiguity warning above, and the hole it left open:
   * an entry whose short id names **no** task on the board at all.
   *
   * `work-log.mjs` records the short id it pulls off a `set-status.js` title
   * (`/^(T\d+\.\d+)\b/`) and nothing else, while the join looks that id up in
   * a table built from board task NAMES. A task renamed out of that notation
   * — "T2.1 - Sign-up" edited to "Sign-up" — or removed from the board
   * outright leaves its worklog entry naming an id nothing answers to. The
   * entry still carries a merge SHA that still resolves: real, recorded
   * evidence, thrown away.
   *
   * That is the same failure the ambiguity warning exists for (evidence that
   * cannot be joined must SAY so), and the first version of the fix guarded
   * it behind `candidates.length > 1`, so only the ambiguous half warned.
   * The zero-candidate half stayed silent, and the mode alone cannot tell
   * "provenance existed but could not be joined" from "no provenance
   * existed" — which is precisely the distinction the warning was added to
   * make visible.
   */
  it("warns rather than silently dropping an entry whose task id names no task on the board", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/orphaned.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Alpha" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M2 - Onboarding" });
    // Renamed out of the `T<m>.<n>` notation the worklog recorded it under.
    const task = createTask(octobotsDir, mission.id, { name: "Sign-up" });
    const board = requireBoard(root);

    const log = [entry({ task: "T2.1", branch: "feat/alpha-m2-t1", mergedSha: sha })];
    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));

    expect(rows).toEqual([{ task: task.id, files: [], deletedFiles: [], mode: "predicted" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("T2.1");
    expect(warnings[0]).toContain("names no task on this board");
  });

  /**
   * The other half of the same rule, and the reason the warning is gated on
   * the SHA resolving: an unrecorded or long-rewritten SHA already falls
   * through to `predicted` for its own stated reason, so warning about it
   * too would bury the one case that means "evidence exists and was lost"
   * under noise from every case that means "there was never any evidence".
   */
  it("stays silent for an unjoinable entry whose SHA no longer resolves here", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });

    const campaign = createCampaign(octobotsDir, { name: "Alpha" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M2 - Onboarding" });
    createTask(octobotsDir, mission.id, { name: "Sign-up" });
    const board = requireBoard(root);

    const log = [
      entry({
        task: "T2.1",
        branch: "feat/alpha-m2-t1",
        mergedSha: "0123456789abcdef0123456789abcdef01234567",
      }),
    ];
    const warnings: string[] = [];
    attribute(root, board, log, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
  });

  /**
   * `harvest` passes `-z` and says why: without it git applies
   * `core.quotePath` and returns `"src/r\303\251sum\303\251.ts"`, quotes and
   * octal escapes included. That string is not a path on disk and matches no
   * node in the harvested graph, so labelling it `provenance` would assert a
   * recorded fact about a file that does not exist. One spelling of the rule,
   * in both readers.
   */
  it("reports a non-ASCII path as it exists on disk, never git's C-quoted rendering", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/résumé.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    expect(attribute(root, board, log)).toEqual([
      { task: task.id, files: ["src/résumé.ts"], deletedFiles: [], mode: "provenance" },
    ]);
  });

  /**
   * `gh`'s `mergeCommit.oid` is a MERGE commit whenever the repo merges PRs
   * rather than squashing them, and plain `diff-tree` reports nothing at all
   * for a multi-parent commit — which produced an empty file list still
   * labelled `provenance`. The first-parent diff is what "the files this PR
   * brought in" means.
   */
  it("attributes a merge-commit SHA to the files the merge brought in, not to nothing", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    git(["checkout", "-q", "-b", "feat/x-t1"]);
    commit(root, git, { "src/brought-in.ts": "export {}\n" });
    git(["checkout", "-q", "main"]);
    commit(root, git, { "src/meanwhile-on-main.ts": "export {}\n" });
    git(["merge", "-q", "--no-ff", "-m", "merge feat/x-t1", "feat/x-t1"]);
    const mergeSha = git(["rev-parse", "HEAD"]).trim();
    expect(git(["rev-list", "--parents", "-n", "1", mergeSha]).trim().split(" ")).toHaveLength(3);

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: mergeSha })];
    // The merge's own side only — never the commit that landed on main in
    // parallel, which the second-parent diff would have dragged in.
    expect(attribute(root, board, log)).toEqual([
      { task: task.id, files: ["src/brought-in.ts"], deletedFiles: [], mode: "provenance" },
    ]);
  });

  /**
   * `worklog.jsonl` is a COMMITTED artifact, so its contents arrive from the
   * repo, and the recorded SHA becomes an argv element of a `git` call.
   * `git diff-tree --output=<file>` writes that file, so a `merged_sha` that
   * is a git option rather than an object name must never be spawned.
   */
  it("never spawns git for a merged_sha that is not an object name", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const pwned = join(root, "pwned.txt");
    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: `--output=${pwned}` })];

    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: [], deletedFiles: [], mode: "predicted" }]);
    expect(existsSync(pwned)).toBe(false);
  });

  /**
   * A SHA that resolves but changed nothing proves nothing about which files
   * the task owns. Labelling that `provenance` would assert, as a recorded
   * fact, that the task owns no files — and would lock the lexical layer out
   * of ever answering for it.
   */
  it("falls through to predicted when a resolvable SHA changed no files", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    git(["commit", "-q", "--allow-empty", "-m", "empty merge of already-landed work"]);
    const emptySha = git(["rev-parse", "HEAD"]).trim();

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: emptySha })];
    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: [], deletedFiles: [], mode: "predicted" }]);
  });

  it("picks the latest recorded SHA when a task logged twice (active, then done)", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const staleSha = commit(root, git, { "src/old.ts": "old\n" });
    const freshSha = commit(root, git, { "src/new.ts": "new\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: staleSha, at: "2026-08-09T00:00:00.000Z" }),
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: freshSha, at: "2026-08-10T00:00:00.000Z" }),
    ];
    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: ["src/new.ts"], deletedFiles: [], mode: "provenance" }]);
  });

  /**
   * The regression this pins: latest-wins tried ONLY the newest recorded
   * `{sha, at}` per task. When that newest sha no longer resolves — a
   * force-push, a rewritten history — the task fell straight to `predicted`,
   * even though an OLDER entry's sha resolves fine and real evidence is
   * sitting right there in the same log. The fix falls back to it, and warns
   * that it did rather than silently answering as if the newer entry had
   * never been logged at all.
   */
  it("falls back to an older resolvable entry when the newest recorded sha no longer resolves, and warns about it", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const staleSha = commit(root, git, { "src/old.ts": "old\n" });
    // A syntactically valid SHA that names no object in this repo — the
    // shape a force-push or a rewritten history leaves behind, logged AFTER
    // the real, resolvable evidence above.
    const goneSha = "0123456789abcdef0123456789abcdef01234567";

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: staleSha, at: "2026-08-09T00:00:00.000Z" }),
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: goneSha, at: "2026-08-10T00:00:00.000Z" }),
    ];
    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));

    // Still `provenance`, from the OLDER entry — not dropped to `predicted`
    // just because the newest one turned out unusable.
    expect(rows).toEqual([{ task: task.id, files: ["src/old.ts"], deletedFiles: [], mode: "provenance" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(task.id);
    expect(warnings[0]).toContain(goneSha);
    expect(warnings[0]).toContain(staleSha);
  });

  /**
   * The sibling case: the newest entry's sha DOES resolve, but its
   * first-parent diff is empty (an empty commit, a re-merge of already-landed
   * work) — exactly as unusable as a sha that does not resolve at all, and
   * the fallback must treat it the same way.
   */
  it("falls back to an older resolvable entry when the newest resolves to an empty diff, and warns about it", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const staleSha = commit(root, git, { "src/old.ts": "old\n" });
    git(["commit", "-q", "--allow-empty", "-m", "empty merge of already-landed work"]);
    const emptySha = git(["rev-parse", "HEAD"]).trim();

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: staleSha, at: "2026-08-09T00:00:00.000Z" }),
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: emptySha, at: "2026-08-10T00:00:00.000Z" }),
    ];
    const warnings: string[] = [];
    const rows = attribute(root, board, log, (m) => warnings.push(m));

    expect(rows).toEqual([{ task: task.id, files: ["src/old.ts"], deletedFiles: [], mode: "provenance" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(emptySha);
  });

  /**
   * The non-regression case: when the NEWEST entry resolves fine, nothing
   * about the fallback machinery should engage or warn — exactly the
   * pre-existing "picks the latest recorded SHA" behaviour above, still
   * silent.
   */
  it("stays silent when the newest recorded entry resolves cleanly on its own", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const staleSha = commit(root, git, { "src/old.ts": "old\n" });
    const freshSha = commit(root, git, { "src/new.ts": "new\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    const log = [
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: staleSha, at: "2026-08-09T00:00:00.000Z" }),
      entry({ task: task.id, branch: "feat/x-t1", mergedSha: freshSha, at: "2026-08-10T00:00:00.000Z" }),
    ];
    const warnings: string[] = [];
    attribute(root, board, log, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  /**
   * `own labels a path DELETED by the very merge it cites as provenance` —
   * the sibling defect: `git diff-tree --name-only` lists a deletion exactly
   * like an addition, so a path a task's own recorded merge REMOVED was
   * indistinguishable from one it still owns. Deleted paths are excluded
   * from `files` and surfaced separately in `deletedFiles`, never silently
   * folded into either "owned" or "never touched".
   */
  it("excludes a path the recorded merge deleted from files, and reports it in deletedFiles instead", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    commit(root, git, { "src/gone.ts": "export {}\n" });
    // The commit under test both ADDS a real, kept file and DELETES the
    // earlier one — so `kept` is non-empty (mode stays `provenance`) while
    // `deleted` still names the removed path, the shape a real cleanup PR
    // takes and the only one that can distinguish "no evidence" from
    // "evidence, minus a path this commit removed".
    unlinkSync(join(root, "src", "gone.ts"));
    const sha = commit(root, git, { "src/kept.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Cleanup" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - Remove dead code" });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    expect(attribute(root, board, log)).toEqual([
      { task: task.id, files: ["src/kept.ts"], deletedFiles: ["src/gone.ts"], mode: "provenance" },
    ]);
  });
});
