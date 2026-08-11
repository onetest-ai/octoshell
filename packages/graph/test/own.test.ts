import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createCampaign, createMission, createTask } from "@octoshell/board";
import { own } from "../src/own.js";
import { readBoard, type BoardView } from "../src/board.js";
import type { WorklogEntry } from "../src/worklog.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function gitIn(root: string) {
  return (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

/** A repo that is both a git repository and an Octobots board — `own` needs
 *  both: `attribute()` resolves a worklog SHA against real commits, and
 *  `readBoard` reads task ids off the board. Mirrors
 *  `attribution.test.ts`'s fixture. */
function repoWithBoardAndGit(): { root: string; octobotsDir: string; git: (args: string[]) => string } {
  const root = mkdtempClean("octograph-own-");
  const git = gitIn(root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  const octobotsDir = join(root, ".octobots");
  mkdirSync(octobotsDir, { recursive: true });
  return { root, octobotsDir, git };
}

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

describe("own", () => {
  it("names the owning mission and criterion for a path attributed by provenance", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n", "src/auth.test.ts": "test\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] jwt is validated",
    });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    const answers = own(root, board, log, [], "src/auth.ts");

    expect(answers).toEqual([
      { path: "src/auth.ts", task: task.id, mission: mission.id, criterion: "jwt is validated", mode: "provenance" },
    ]);
  });

  it("does not answer for a path a provenance-attributed task never touched", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] jwt is validated",
    });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    expect(own(root, board, log, [], "src/unrelated.ts")).toEqual([]);
  });

  /**
   * The day-one state of every adopting repo (see the M4 plan's "finding
   * that reshapes this mission"): a worklog holding only mission-level
   * entries (no `task` field), so `attribute()` labels every task
   * `predicted` with no recorded files. `own` must still answer — via the
   * lexical fallback — and must label the answer `predicted`, never silently
   * omit it and never mislabel it `provenance`.
   */
  it("still answers, labelled predicted, against a worklog holding only mission-level entries", () => {
    const { root, octobotsDir } = repoWithBoardAndGit();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      // A single criterion: the "several criteria, which one" question is
      // covered separately below ("picks the criterion whose own tokens
      // best overlap the path"). Mixing both concerns into one fixture
      // means picking criteria text that satisfies two independent scoring
      // functions (predictFiles's corpus-wide idf ranking AND
      // bestCriterion's path-local overlap) at once — needlessly fragile.
      acceptanceCriteria: "- [ ] the session token is validated on every login attempt",
    });
    const board = requireBoard(root);

    // Mission-level entry only — no `task` field, exactly what
    // `hooks/work-log.mjs` writes before any task-scoped entry exists.
    const log = [entry({ mission: mission.id })];
    const candidates = [
      "src/auth/session.ts",
      "src/auth/login.ts",
      "src/billing/invoice.ts",
      "src/billing/ledger.ts",
      "docs/readme.md",
    ];

    const answers = own(root, board, log, candidates, "src/auth/session.ts");
    expect(answers).toEqual([
      {
        path: "src/auth/session.ts",
        task: task.id,
        mission: mission.id,
        criterion: "the session token is validated on every login attempt",
        mode: "predicted",
      },
    ]);
  });

  it("answers nothing, rather than throwing, when the lexical fallback has no confident match", () => {
    const { root, octobotsDir } = repoWithBoardAndGit();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    createTask(octobotsDir, mission.id, {
      name: "T1.1 - Boilerplate",
      acceptanceCriteria: "- [ ] the code is well tested",
    });
    const board = requireBoard(root);

    const candidates = ["src/auth/session.ts", "src/billing/invoice.ts", "src/checkout/cart.ts"];
    expect(own(root, board, [], candidates, "src/auth/session.ts")).toEqual([]);
  });

  it("picks the criterion whose own tokens best overlap the path when a task has several", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/auth/session.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria:
        "- [ ] the billing invoice totals are correct\n" + "- [ ] the auth session token is validated",
    });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    const answers = own(root, board, log, [], "src/auth/session.ts");

    expect(answers).toEqual([
      {
        path: "src/auth/session.ts",
        task: task.id,
        mission: mission.id,
        criterion: "the auth session token is validated",
        mode: "provenance",
      },
    ]);
  });

  it("orders multiple answers deterministically by (mission, task, path)", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/shared.ts": "export {}\n" });

    const campaignA = createCampaign(octobotsDir, { name: "A" });
    const missionA = createMission(octobotsDir, campaignA.id, { title: "M1 - Zeta" });
    const taskA = createTask(octobotsDir, missionA.id, {
      name: "T1.1 - Zeta",
      acceptanceCriteria: "- [ ] zeta",
    });
    const campaignB = createCampaign(octobotsDir, { name: "B" });
    const missionB = createMission(octobotsDir, campaignB.id, { title: "M1 - Alpha" });
    const taskB = createTask(octobotsDir, missionB.id, {
      name: "T1.1 - Alpha",
      acceptanceCriteria: "- [ ] alpha",
    });
    const board = requireBoard(root);

    const log = [
      entry({ task: taskA.id, branch: "feat/a", mergedSha: sha }),
      entry({ task: taskB.id, branch: "feat/b", mergedSha: sha }),
    ];
    const answers = own(root, board, log, [], "src/shared.ts");
    expect(answers.map((a) => a.mission)).toEqual([missionA.id, missionB.id].sort());
  });
});
