import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
      { task: task.id, files: ["src/auth.test.ts", "src/auth.ts"], mode: "provenance" },
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
    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: [], mode: "predicted" }]);
  });

  it("labels a task with no recorded SHA predicted rather than omitting it", () => {
    const { root, octobotsDir } = repoWithBoardAndGit();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, { name: "T1.1 - JWT" });
    const board = requireBoard(root);

    expect(attribute(root, board, [])).toEqual([{ task: task.id, files: [], mode: "predicted" }]);
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
      { task: task.id, files: ["src/auth.ts"], mode: "provenance" },
    ]);
  });

  /**
   * A short id is unique within a campaign and nowhere else — this repo's
   * board shares 14 of them across campaigns. Attributing one campaign's
   * `T1.1` merge to another campaign's `T1.1` would be a wrong answer
   * wearing the `provenance` label, which is worse than no answer.
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
    const rows = attribute(root, board, log);
    expect(rows.map((r) => r.mode)).toEqual(["predicted", "predicted"]);
    expect(new Set(rows.map((r) => r.task))).toEqual(new Set([a.id, b.id]));

    // …and the ambiguity is what withheld it: the same log against a board
    // where only one T1.1 exists does attribute.
    const soloBoard: BoardView = { ...board, tasks: board.tasks.filter((t) => t.id === a.id) };
    expect(attribute(root, soloBoard, log)).toEqual([
      { task: a.id, files: ["src/auth.ts"], mode: "provenance" },
    ]);
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
      { task: task.id, files: ["src/résumé.ts"], mode: "provenance" },
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
      { task: task.id, files: ["src/brought-in.ts"], mode: "provenance" },
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

    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: [], mode: "predicted" }]);
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
    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: [], mode: "predicted" }]);
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
    expect(attribute(root, board, log)).toEqual([{ task: task.id, files: ["src/new.ts"], mode: "provenance" }]);
  });
});
