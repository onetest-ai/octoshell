import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdtempClean } from "./tmpdir.js";

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
    } catch (err) {
      // Four CI-only failures, never once locally, always the heaviest
      // fixture, always mid-sequence. Adding stderr to the assertion moved the
      // diagnosis from "expected 0 to be 1" to `fatal: could not parse HEAD`;
      // this captures the repository's state at the instant it failed, because
      // every remaining theory is about that state.
      //
      // Wraps EVERY git call in the build, not just `commit`: the first
      // symptom reproduced locally came from `rev-list --count --all` on the
      // very first line, reporting `not a git repository` — a different
      // message for the same underlying condition, which a commit-only guard
      // would have missed entirely.
      //
      // Re-throws deliberately. A diagnostic that swallows the error turns a
      // loud CI failure into a fixture that quietly builds the wrong history.
      throw new Error(
        `fixture step failed: ${what}\nin ${root}\n` +
          `original: ${(err as Error).message}\n` +
          `state at failure:\n${describeRepoState(root)}`,
      );
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
