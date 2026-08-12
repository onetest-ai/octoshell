import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdtempClean } from "./tmpdir.js";

/** How long to pause before a fixture git call's single retry. Long enough
 *  for a transient filesystem or process condition to clear, short enough
 *  that 47 sequential commits do not visibly slow the suite. */
const RETRY_PAUSE_MS = 100;

export interface CommitSpec {
  /** Repo-relative paths touched by this commit. */
  files: string[];
  /** Age of the commit in days. Defaults to 0 (now). */
  daysAgo?: number;
  /** Commit subject. Defaults to `commit <n>`. Set it to give a commit the
   *  shape a forge leaves behind on a squash merge — a trailing `(#123)` —
   *  which `squashShape` detects and `doctor` reports. */
  message?: string;
}

function gitIn(root: string) {
  return (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
}

/**
 * Add commits to an existing fixture repo. `seq` seeds file contents so a
 * second call writes different bytes and git actually records a change.
 *
 * The seed is offset by the number of commits already in the repo, so calling
 * this twice with the same `seq` and the same file set still writes fresh
 * bytes each round. Without that offset the second round is a no-op diff and
 * `git commit` exits non-zero — a trap for tests that build history in stages
 * (the cluster-stability test does exactly that). Still deterministic: the
 * offset is a function of repo state, not of wall-clock time.
 */
export function appendCommits(root: string, commits: CommitSpec[], seq = 1000): void {
  const git = gitIn(root);
  /** Run a fixture git command, and on failure report the repo's own state. */
  const step = <T,>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (first) {
      // MITIGATION FOR AN UNEXPLAINED FAULT — not a fix, and deliberately loud.
      //
      // This fixture's git calls fail on CI at a measured ~1.9% per suite
      // execution (5 occurrences in 268 executions, 95% CI 0.8-4.3%), always
      // mid-sequence, always `fatal: could not parse HEAD` or a sibling
      // message. 68 deliberate reproduction runs on real ubuntu runners — 48
      // of the file alone, 20 of the whole suite — produced ZERO failures,
      // which at 1.9% is unremarkable (p ≈ 28%) and rules out the ~10% rate
      // the clustering first suggested. Ruled out with evidence: disk
      // pressure, macOS concurrency, CPU contention, inherited GIT_* env,
      // PATH mutation across files, glob-based temp cleanup, and the
      // checkout-ref difference between triggers.
      //
      // At that rate, chasing the cause is a several-hundred-run proposition
      // and the fixture is INFRASTRUCTURE, not the system under test: a
      // transient git failure while building scripted history is not a
      // product signal. So it retries ONCE.
      //
      // Three things keep this from being "retry until green", which is what
      // hid this fault for two days in the first place:
      //   1. Exactly one retry. A second consecutive failure throws.
      //   2. It PRINTS when it retries, with the repo state that prompted it,
      //      so a systematic problem still surfaces in the CI log instead of
      //      being silently absorbed.
      //   3. The state dump is captured BEFORE the retry, because a
      //      successful retry would otherwise destroy the only evidence.
      const stateBefore = describeRepoState(root);
      // Every line carries the prefix. CI interleaves output from parallel
      // test files, and an unprefixed state dump lands in the log with no
      // way to tell which fixture it belongs to — which is the whole reason
      // this is being printed.
      const say = (line: string): void => void process.stderr.write(`[fixture retry] ${line}\n`);
      say(`${what} failed in ${root}`);
      say((first as Error).message.split("\n").slice(0, 2).join(" | "));
      for (const line of stateBefore.split("\n")) say(line);
      say("retrying once — see the filed bug 'packages/graph e2e heaviest fixture'");
      // A brief synchronous pause, so a genuinely transient condition has a
      // moment to clear. Sync because everything around it is: an async sleep
      // here would reorder the git calls this fixture depends on being serial.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_PAUSE_MS);
      try {
        return fn();
      } catch (second) {
        throw new Error(
          `fixture step failed TWICE: ${what}\nin ${root}\n` +
            `first:  ${(first as Error).message}\n` +
            `second: ${(second as Error).message}\n` +
            `state before retry:\n${stateBefore}\n` +
            `state after retry:\n${describeRepoState(root)}`,
        );
      }
    }
  };
  const existing = Number(
    step("rev-list --count --all", () => git(["rev-list", "--count", "--all"])).toString().trim(),
  );
  commits.forEach((spec, i) => {
    const stamp = seq + existing + i;
    for (const rel of spec.files) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      // Content must change or git records no diff for the file.
      writeFileSync(abs, `content ${stamp}\n`);
    }
    step(`add -A (commit ${i + 1} of ${commits.length})`, () => git(["add", "-A"]));
    const when = new Date(Date.UTC(2026, 0, 1) - (spec.daysAgo ?? 0) * 86400000).toISOString();
    step(`commit ${i + 1} of ${commits.length}`, () =>
      git(["commit", "-q", "-m", spec.message ?? `commit ${stamp}`], {
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      }));
  });
}

/**
 * Everything about a fixture repo that the four observed CI failures could
 * plausibly be explained by, gathered without throwing — a diagnostic that
 * itself dies tells you nothing.
 */
function describeRepoState(root: string): string {
  const lines: string[] = [];
  const safe = (label: string, fn: () => string): void => {
    try {
      lines.push(`  ${label}: ${fn().trim().replace(/\n/g, " | ").slice(0, 300)}`);
    } catch (e) {
      lines.push(`  ${label}: <failed: ${(e as Error).message.split("\n")[0]}>`);
    }
  };
  safe("root exists", () => String(existsSync(root)));
  safe(".git exists", () => String(existsSync(join(root, ".git"))));
  safe("HEAD file", () => readFileSync(join(root, ".git", "HEAD"), "utf8"));
  safe("refs/heads", () => readdirSync(join(root, ".git", "refs", "heads")).join(","));
  safe("index.lock", () => String(existsSync(join(root, ".git", "index.lock"))));
  // Any of these set in the environment silently redirects EVERY git call away
  // from the fixture, which is the one hypothesis that would explain a repo
  // looking simultaneously mid-history and empty.
  for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
    if (process.env[v] !== undefined) lines.push(`  env ${v}: ${process.env[v]}`);
  }
  safe("git status", () => execFileSync("git", ["status", "--porcelain=v1", "-b"], {
    cwd: root, encoding: "utf8", stdio: "pipe",
  }));
  safe("git rev-list --count --all", () => execFileSync("git", ["rev-list", "--count", "--all"], {
    cwd: root, encoding: "utf8", stdio: "pipe",
  }));
  return lines.join("\n");
}

/** Build a throwaway git repo with a scripted history. Returns its path. */
export function buildRepo(commits: CommitSpec[]): string {
  const root = mkdtempClean("octograph-");
  const git = gitIn(root);

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  appendCommits(root, commits, 0);
  return root;
}
