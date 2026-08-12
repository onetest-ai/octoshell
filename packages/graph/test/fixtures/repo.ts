import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdtempClean } from "./tmpdir.js";

export interface CommitSpec {
  /** Repo-relative paths touched by this commit. */
  files: string[];
  /** Age of the commit in days. Defaults to 0 (now). */
  daysAgo?: number;
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
  const existing = Number(git(["rev-list", "--count", "--all"]).toString().trim());
  commits.forEach((spec, i) => {
    const stamp = seq + existing + i;
    for (const rel of spec.files) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      // Content must change or git records no diff for the file.
      writeFileSync(abs, `content ${stamp}\n`);
    }
    git(["add", "-A"]);
    const when = new Date(Date.UTC(2026, 0, 1) - (spec.daysAgo ?? 0) * 86400000).toISOString();
    git(["commit", "-q", "-m", `commit ${stamp}`], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });
  });
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
