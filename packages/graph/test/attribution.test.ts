import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
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
