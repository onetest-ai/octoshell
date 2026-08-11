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
      // `auth` is shared with the path — the criterion is NAMED here because
      // the path's own words support it, which is the only reason this module
      // ever names one. The zero-overlap case is a different answer, and has
      // its own test below.
      acceptanceCriteria: "- [ ] the auth token is validated",
    });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    const answers = own(root, board, log, [], "src/auth.ts");

    expect(answers).toEqual([
      {
        path: "src/auth.ts",
        task: task.id,
        mission: mission.id,
        criterion: "the auth token is validated",
        // The file came off a recorded merge; the criterion is a lexical
        // guess even so. Two answers, two labels.
        mode: "provenance",
        criterionMode: "predicted",
      },
    ]);
  });

  /**
   * The regression this test exists for — the sixth instance of this
   * campaign's recurring defect, and the purest: a criterion chosen by
   * nothing at all, wearing the ownership row's `provenance` badge.
   *
   * `bestCriterion`'s first version returned the `compare`-first criterion
   * among ties INCLUDING ties at score zero, and `own` stamped one `mode` on
   * the whole row. Run against this repo it printed
   * `packages/graph/src/louvain.ts … (provenance) criterion: autoResolution
   * returns 1.0 below 2 nodes, 0.6 at 100, and floors at 0.3` — a criterion
   * sharing not one token with that path, first only alphabetically, sold as
   * a recorded fact. The file attribution WAS a fact; the criterion never
   * was, and nothing in the row said so.
   */
  it("names no criterion, and never labels one provenance, when no criterion's words support the path", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "src/louvain.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Clustering" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.5 - Louvain",
      // Not one token in common with `src/louvain.ts`. The first criterion
      // also sorts first, which is exactly how it used to win.
      acceptanceCriteria:
        "- [ ] autoResolution returns 1.0 below 2 nodes\n- [ ] repeated runs return identical partitions",
    });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    const answers = own(root, board, log, [], "src/louvain.ts");

    // The ownership half survives — it IS a recorded fact — and is still
    // labelled `provenance`. Only the criterion half, which never had
    // evidence, is withheld.
    expect(answers).toEqual([
      {
        path: "src/louvain.ts",
        task: task.id,
        mission: mission.id,
        criterion: null,
        mode: "provenance",
        criterionMode: null,
      },
    ]);
  });

  /**
   * The same rule at the other end: two criteria the path supports EQUALLY.
   * Measured on this repo — `packages/graph/src/components.ts` scores 1 for
   * "two isolated components become one after bridging" (via `components`)
   * and 1 for "an already-connected graph gains no edges" (via `graph`, which
   * it only shares because the package directory is called `graph`). Breaking
   * that by `compare` named the second: alphabetical order presented as
   * "which criterion this file exists to satisfy".
   */
  it("names no criterion when two criteria are tied on the evidence the path offers", () => {
    const { root, octobotsDir, git } = repoWithBoardAndGit();
    commit(root, git, { "README.md": "seed\n" });
    const sha = commit(root, git, { "graph/components.ts": "export {}\n" });

    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Clustering" });
    const task = createTask(octobotsDir, mission.id, {
      name: "T1.7 - Bridging",
      acceptanceCriteria:
        "- [ ] an already-connected graph gains no edges\n- [ ] two isolated components become one after bridging",
    });
    const board = requireBoard(root);

    const log = [entry({ task: task.id, branch: "feat/x-t1", mergedSha: sha })];
    const answers = own(root, board, log, [], "graph/components.ts");

    expect(answers.map((a) => [a.criterion, a.criterionMode])).toEqual([[null, null]]);
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
        criterionMode: "predicted",
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
        criterionMode: "predicted",
      },
    ]);
  });

  /**
   * The second claim this shipped without evidence: an ownership answer about
   * a path that is not in the repo at all.
   *
   * `withCandidate` folds the queried path into the lexical corpus so a real
   * file outside the co-change corpus can still be answered for — but its
   * first version folded in ANY string. Run against this repo,
   * `own src/jaccard/empty-sets-score-nan.ts` — a path invented from T1.6's
   * own criteria wording, naming no file that exists — answered "owned by
   * m1-co-change-engine / t1-6 (predicted)", indistinguishable from an answer
   * about a real file. Here `src/auth/session.ts` names nothing on disk and
   * is not in `candidates`; the same query for a file that DOES exist is the
   * mission-level-worklog test above.
   */
  it("does not answer for a path that names no file in the repo", () => {
    const { root, octobotsDir } = repoWithBoardAndGit();
    const campaign = createCampaign(octobotsDir, { name: "Q3" });
    const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
    createTask(octobotsDir, mission.id, {
      name: "T1.1 - JWT",
      acceptanceCriteria: "- [ ] the session token is validated on every login attempt",
    });
    const board = requireBoard(root);

    const candidates = ["src/billing/invoice.ts", "src/billing/ledger.ts", "docs/readme.md"];
    expect(own(root, board, [entry({ mission: mission.id })], candidates, "src/auth/session.ts")).toEqual(
      [],
    );

    // Same query, same board — but now the file is really there.
    mkdirSync(join(root, "src", "auth"), { recursive: true });
    writeFileSync(join(root, "src", "auth", "session.ts"), "export {}\n");
    const found = own(root, board, [entry({ mission: mission.id })], candidates, "src/auth/session.ts");
    expect(found.map((a) => [a.path, a.mode])).toEqual([["src/auth/session.ts", "predicted"]]);
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
