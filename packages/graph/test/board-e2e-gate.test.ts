import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCampaign, createMission, createTask } from "@octoshell/board";
import { buildRepo } from "./fixtures/repo.js";
import { runNode } from "./fixtures/run-node.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/**
 * T4.6 — M4's own end-to-end gate, mirroring what T3.6's `e2e-gate.test.ts`
 * did for M3: every assertion below drives the REAL, SHIPPED bundle
 * (`scripts/bundle.mjs`'s output) under bare `node`, in a directory with no
 * `node_modules` anywhere up the chain, and reads back the actual bytes the
 * process printed to stdout/stderr — never `runCli()`'s in-process
 * `CliResult`, which `cli.test.ts`/`own.test.ts`/`conflicts.test.ts` already
 * cover thoroughly at the unit level. M2 fixed one dangling-reference defect
 * three times because every fix was pinned over the in-memory `Analysis`
 * instead of the artifact that gets committed; this file exists so the same
 * mistake cannot happen quietly to `own`/`conflicts`.
 *
 * `own`/`conflicts` write nothing to disk (unlike `map`'s `map.md`/
 * `clusters.json`) — their "artifact" is the line of text a caller actually
 * sees, so "rendered output" here means the child process's real stdout,
 * captured through `runNode`, never a parsed-back-into-memory shortcut.
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Builds the bundle fresh, straight into an isolated temp directory — never
 * `dist/octograph.mjs` itself (that path is `bundle.test.ts`'s own subject,
 * and Vitest runs test files in parallel, so writing there too races that
 * file's build/copy over the same bytes) and never a hand-written second
 * copy of the bundling rule. Same reasoning `e2e-gate.test.ts`'s bundle test
 * documents at length.
 *
 * Under the OS temp dir there is no `node_modules` anywhere up the chain, so
 * any specifier `scripts/bundle.mjs` failed to inline fails to resolve and
 * `node` exits before printing anything — the same self-containment proof
 * `bundle.test.ts` runs for `doctor` alone, exercised here for `own` and
 * `conflicts` too (criterion 5).
 */
function buildIsolatedBundle(): string {
  const isolated = join(mkdtempClean("octograph-board-gate-bundle-"), "octograph.mjs");
  execFileSync("node", ["scripts/bundle.mjs", isolated], { cwd: PKG_ROOT, stdio: "pipe" });
  return isolated;
}

function gitIn(root: string) {
  return (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

/** A repo that is both a git repository and an Octobots board, with no
 *  scripted history of its own — callers add commits via `commit()` below,
 *  one at a time, so a test can capture the exact SHA it needs. Mirrors
 *  `attribution.test.ts`'s and `cli.test.ts`'s own `repoWithBoardAndGit`. */
function repoWithBoardAndGit(): { root: string; octobotsDir: string; git: (args: string[]) => string } {
  const root = mkdtempClean("octograph-board-gate-repo-");
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

/** Writes `.octobots/tokenomics/worklog.jsonl` in the shape
 *  `hooks/work-log.mjs` actually writes — snake_case keys. Overwrites
 *  whatever was there before, so a test can rewrite the SAME entry across
 *  several `own` invocations to prove the mode moves with the evidence. */
function writeWorklog(root: string, lines: Array<Record<string, unknown>>): void {
  const dir = join(root, ".octobots", "tokenomics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worklog.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("end-to-end via the shipped bundle: a repo with no .octobots board", () => {
  it(
    "runs map/impact/drift/doctor normally, reading back real files off disk, and fails own/conflicts with a clear message and non-zero exit",
    () => {
      const bundle = buildIsolatedBundle();
      const repo = buildRepo([
        { files: ["a.ts", "b.ts"] },
        { files: ["a.ts", "b.ts"], daysAgo: 1 },
      ]);
      expect(existsSync(join(repo, "node_modules"))).toBe(false);
      expect(existsSync(join(repo, ".octobots"))).toBe(false);

      // map: a real artifact, read back off disk — never the in-memory
      // Analysis this suite's own unit tests already hold onto.
      const map = runNode([bundle, "map"], repo);
      expect(map.code).toBe(0);
      expect(map.stdout).toContain("wrote");
      const mapMd = readFileSync(join(repo, ".octograph", "map.md"), "utf8");
      expect(mapMd).toContain("commits analysed");
      expect(existsSync(join(repo, ".octograph", "clusters.json"))).toBe(true);

      const impact = runNode([bundle, "impact", "a.ts"], repo);
      expect(impact.code).toBe(0);

      const drift = runNode([bundle, "drift"], repo);
      expect(drift.code).toBe(0);

      // doctor legitimately exits non-zero on a degraded/blocked report — the
      // claim here is only that it RUNS and reports, same as every other
      // boardless command, not that it grades this thin fixture "ok".
      const doctor = runNode([bundle, "doctor"], repo);
      expect(doctor.stdout).toContain("status:");

      // own/conflicts are the two commands that need a board — the one
      // divergence from every command above, and the whole point of this
      // fixture.
      //
      // Asserted on the WHOLE message, never on the substring "board": a
      // bundle that failed to inline `@octoshell/board` dies with `Cannot
      // find package '@octoshell/board' imported from …` on stderr, an empty
      // stdout and a non-zero exit — which satisfies "exits non-zero",
      // "prints nothing to stdout" AND "stderr mentions board", all three, so
      // the crash this whole file exists to catch is indistinguishable from
      // the deliberate refusal it means to pin. The criterion asks for a CLEAR
      // MESSAGE; the message is the thing to assert, and `ERR_MODULE_NOT_FOUND`
      // is named explicitly so the one failure that could impersonate it
      // cannot.
      const own = runNode([bundle, "own"], repo);
      expect(own.code).not.toBe(0);
      expect(own.stdout).toBe("");
      expect(own.stderr).toContain("no .octobots board found — own needs one to answer");
      expect(own.stderr).not.toContain("ERR_MODULE_NOT_FOUND");

      const ownWithPath = runNode([bundle, "own", "a.ts"], repo);
      expect(ownWithPath.code).not.toBe(0);
      expect(ownWithPath.stderr).toContain("no .octobots board found — own needs one to answer");
      expect(ownWithPath.stderr).not.toContain("ERR_MODULE_NOT_FOUND");

      const conflicts = runNode([bundle, "conflicts", "anything"], repo);
      expect(conflicts.code).not.toBe(0);
      expect(conflicts.stdout).toBe("");
      expect(conflicts.stderr).toContain("no .octobots board found — conflicts needs one to answer");
      expect(conflicts.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    },
    30_000,
  );
});

describe("end-to-end via the shipped bundle: a day-one, mission-only worklog", () => {
  it(
    "answers own in predicted mode — asserted on the process's real rendered stdout, never provenance",
    () => {
      const bundle = buildIsolatedBundle();
      // A real co-change corpus so the lexical predictor has more than one
      // candidate to discriminate against (see lexical.ts's idf — a
      // single-candidate corpus scores every token 0 by arithmetic, not by
      // evidence).
      const repo = buildRepo([
        { files: ["src/auth/session.ts", "src/auth/login.ts"] },
        { files: ["src/auth/session.ts", "src/auth/login.ts"], daysAgo: 1 },
        { files: ["src/billing/invoice.ts", "src/billing/ledger.ts"] },
        { files: ["src/billing/invoice.ts", "src/billing/ledger.ts"], daysAgo: 1 },
      ]);
      const octobotsDir = join(repo, ".octobots");
      mkdirSync(octobotsDir, { recursive: true });
      const campaign = createCampaign(octobotsDir, { name: "Q3" });
      const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
      // Task id unused below: this fixture's whole point is a worklog entry
      // that names no task (see the comment beneath), so nothing here reads
      // `task.id` — the created task only needs to exist on the board for
      // `own` to have somewhere to attribute the file.
      createTask(octobotsDir, mission.id, {
        name: "T1.1 - JWT",
        acceptanceCriteria: "- [ ] the session token is validated on every login attempt",
      });
      // Day-one state: the worklog holds only a MISSION-level entry (no
      // `task` field at all) — the shape every adopting repo starts in, per
      // this task's own name, and the shape this repo was actually in on
      // 2026-08-09 per the mission plan's own measurement.
      //
      // The entry carries a RESOLVABLE merge SHA, and one whose commit really
      // did touch the queried file. Without it this fixture could not fail for
      // the reason the criterion names: `attribution.ts`'s `attribute()`
      // skips an entry with no `merged_sha` WHETHER OR NOT it also refuses
      // mission-level entries, so a regression that started joining
      // provenance on `mission` would have kept this test green while
      // breaking exactly the thing it is named for. With the SHA present, that
      // regression renders a `(provenance)` row for `src/auth/session.ts` and
      // trips both assertions below.
      const missionSha = gitIn(repo)(["log", "-n", "1", "--format=%H", "--", "src/auth/session.ts"]).trim();
      expect(missionSha).not.toBe("");
      writeWorklog(repo, [
        { session_id: "s1", mission: mission.id, merged_sha: missionSha, at: "2026-08-10T00:00:00.000Z" },
      ]);

      const result = runNode([bundle, "own", "src/auth/session.ts"], repo);
      expect(result.code).toBe(0);
      // The OWNERSHIP clause specifically, not a bare `(predicted)` anywhere
      // on the line: `formatOwnAnswer` prints `criterion (predicted): …`
      // unconditionally on every row that names a criterion, so
      // `toContain("(predicted)")` is satisfied by the criterion half and
      // asserts nothing whatever about the mode this test is named for. The
      // spec's "there is no third mode to fall into" is only policed by
      // reading the label where it is printed.
      expect(result.stdout).toContain(`owned by M1 - Auth / T1.1 - JWT (predicted)`);
      // Criterion 4, checked at the point of production: nothing in this
      // rendered line may claim provenance when the only evidence behind it
      // is a lexical guess.
      expect(result.stdout).not.toContain("provenance");
    },
    30_000,
  );
});

describe("end-to-end via the shipped bundle: the mode moves when the evidence does", () => {
  it(
    "answers provenance with a resolvable merged_sha, then predicted once it is removed, then predicted (never an error) once it is replaced with a SHA absent from the repo",
    () => {
      const bundle = buildIsolatedBundle();
      const { root, octobotsDir, git } = repoWithBoardAndGit();
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      commit(root, git, { "README.md": "seed\n" });
      // Background churn so the lexical corpus (exercised once the SHA is no
      // longer usable) has more than the one owned pair to discriminate
      // against — same reasoning as the mission-only-worklog fixture above.
      commit(root, git, { "bg/1a.ts": "a\n", "bg/1b.ts": "b\n" });
      commit(root, git, { "bg/2a.ts": "a\n", "bg/2b.ts": "b\n" });
      const sha = commit(root, git, {
        "src/auth/session.ts": "export {}\n",
        "src/auth/login.ts": "export {}\n",
      });

      const campaign = createCampaign(octobotsDir, { name: "Q3" });
      const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
      const task = createTask(octobotsDir, mission.id, {
        name: "T1.1 - JWT",
        acceptanceCriteria: "- [ ] the auth session token is validated",
      });

      // (1) A resolvable merged_sha: own answers provenance for the file it
      // named, read straight off the rendered stdout of a real process.
      writeWorklog(root, [
        { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: sha, at: "2026-08-10T00:00:00.000Z" },
      ]);
      const provenanceResult = runNode([bundle, "own", "src/auth/session.ts"], root);
      expect(provenanceResult.code).toBe(0);
      expect(provenanceResult.stdout).toContain(`owned by M1 - Auth / T1.1 - JWT (provenance)`);
      // Criterion 4 at the ONE place in this file where it can actually be
      // violated. This is the only row the whole suite renders that carries a
      // `provenance` badge, and its criterion half is a lexical guess like
      // every other criterion this CLI prints — no commit, hook or worklog
      // entry records which acceptance criterion a file was written to
      // satisfy. `own` really did ship `(provenance) criterion: …` once (see
      // own.ts's `OwnAnswer.criterionMode`), and a bare
      // `toContain("(provenance)")` passes whichever label the criterion
      // clause wears, so the label has to be read where it is printed.
      expect(provenanceResult.stdout).toContain(
        "criterion (predicted): the auth session token is validated",
      );
      expect(provenanceResult.stdout).not.toContain("criterion (provenance)");

      // (2) The SAME entry, merged_sha removed. The mode must move with the
      // evidence, not stay pinned to what an earlier run against this same
      // repo answered.
      writeWorklog(root, [
        { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: null, at: "2026-08-10T00:00:00.000Z" },
      ]);
      const noShaResult = runNode([bundle, "own", "src/auth/session.ts"], root);
      expect(noShaResult.code).toBe(0);
      expect(noShaResult.stderr).toBe("");
      // Read on the ownership clause, for the same reason the day-one fixture
      // above spells it out: the criterion clause prints `(predicted)` on
      // every row regardless.
      expect(noShaResult.stdout).toContain(`owned by M1 - Auth / T1.1 - JWT (predicted)`);
      expect(noShaResult.stdout).not.toContain("provenance");

      // (3) A syntactically valid SHA that names no object in this repo — a
      // force-push or rewritten-history's leftovers. Falls through to
      // predicted, never an error, a non-zero exit, or a stack trace on
      // stderr — the "removing the SHA" case and the "SHA that does not
      // resolve" case are DIFFERENT evidence states and both must land here.
      const goneSha = "0123456789abcdef0123456789abcdef01234567";
      writeWorklog(root, [
        { session_id: "s1", task: task.id, branch: "feat/x-t1", merged_sha: goneSha, at: "2026-08-10T00:00:00.000Z" },
      ]);
      const goneShaResult = runNode([bundle, "own", "src/auth/session.ts"], root);
      expect(goneShaResult.code).toBe(0);
      expect(goneShaResult.stderr).toBe("");
      expect(goneShaResult.stdout).toContain(`owned by M1 - Auth / T1.1 - JWT (predicted)`);
      expect(goneShaResult.stdout).not.toContain("provenance");
    },
    30_000,
  );
});

describe("end-to-end via the shipped bundle: conflicts", () => {
  it(
    "runs under bare node with no node_modules and reports a shared-file conflict, permanently labelled predicted",
    () => {
      const bundle = buildIsolatedBundle();
      const repo = buildRepo([
        { files: ["src/auth/session.ts", "src/billing/invoice.ts"] },
        { files: ["src/auth/session.ts", "src/billing/invoice.ts"], daysAgo: 1 },
      ]);
      expect(existsSync(join(repo, "node_modules"))).toBe(false);

      const octobotsDir = join(repo, ".octobots");
      mkdirSync(octobotsDir, { recursive: true });
      const campaign = createCampaign(octobotsDir, { name: "Q3" });
      const mission = createMission(octobotsDir, campaign.id, { title: "M1 - Auth" });
      // Both tasks predict the SAME file — a `shared` conflict, the direct
      // collision `conflicts` exists to surface.
      const taskA = createTask(octobotsDir, mission.id, {
        name: "T1.1 - JWT",
        acceptanceCriteria: "- [ ] the auth session token is validated",
      });
      const taskB = createTask(octobotsDir, mission.id, {
        name: "T1.2 - Refresh",
        acceptanceCriteria: "- [ ] the auth session token is validated",
      });

      const result = runNode([bundle, "conflicts", mission.id], repo);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.code).toBe(0);
      // The pair AND its mode in one assertion, in the `compare` order
      // `conflicts` emits (`t1-1-jwt` before `t1-2-refresh`) — naming the two
      // ids separately would pass on any pairing of them at all.
      expect(result.stdout).toContain(`${taskA.id} <-> ${taskB.id} (predicted)`);
      // A SHARED-file conflict, which is what this test is named for. Without
      // this, a run whose `shared` collapsed to `(none)` while `coupled`
      // stayed above zero still prints a row for the same two tasks and the
      // test goes green under a name that no longer describes it — the
      // narrower-count-behind-a-broader-label defect this campaign keeps
      // shipping, in the assertion instead of the code.
      expect(result.stdout).toContain("shared=src/auth/session.ts");
      expect(result.stdout).not.toContain("provenance");
      // What the answer rests on, printed on the run that FOUND something as
      // well as on the run that found nothing — a partial answer read as a
      // total one is the same defect as an empty one read as a clean bill of
      // health, and only this line separates either from its opposite.
      expect(result.stdout).toContain("coverage (predicted): 2 of 2 tasks");
    },
    30_000,
  );
});
