import { execFileSync } from "node:child_process";
import { isExcludedPath } from "./noise.js";
import { compare } from "./rollup.js";

/** Which change set `impact --diff` measures. */
export type DiffScope =
  | { kind: "branch" }
  | { kind: "staged" }
  | { kind: "worktree" };

/**
 * Run git and return stdout, or null on any failure.
 *
 * `execFileSync` (never `execSync`): a ref name reaches this from the CLI, and
 * a shell would interpret it. Nothing here is a shell command.
 *
 * Null, not a throw, on every failure — not a git repository, an unknown base
 * ref, an unborn HEAD. `impact --diff` is answerable-or-not, and a missing
 * answer is reported by the caller as "we cannot see", never as a crash.
 */
function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Split a NUL-delimited git list.
 *
 * `-z` throughout, exactly as `harvest.ts` reads `git log`: POSIX forbids only
 * `/` and NUL in a path, so a repo-relative path may legally contain a
 * NEWLINE. A line-split list silently turns one such path into two entries,
 * neither of which is a real file.
 */
function nulList(out: string | null): string[] {
  if (out === null) return [];
  return out.split("\0").filter((s) => s !== "");
}

/** `git status --porcelain -z` records: 2 status chars, a space, then the path. */
function porcelainPaths(out: string | null): string[] {
  const paths: string[] = [];
  const records = nulList(out);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // A rename record is `R  <new>` followed by a SEPARATE NUL-terminated
    // record holding the OLD path. Consume it, and keep the new path only —
    // the old one no longer exists, so no co-change row could name it.
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
    paths.push(path);
  }
  return paths;
}

/**
 * The repo-relative paths a scope covers, sorted and deduplicated.
 *
 * `branch` — the default — is `merge-base(base, HEAD)..HEAD` PLUS uncommitted
 * work. That is the question an executing agent actually has: a mission is a
 * feature branch and a task is a small PR into it, so "what has this branch
 * touched so far" spans several commits and whatever is not committed yet.
 * Measuring only `HEAD~1..HEAD` would answer for the last commit, which is
 * never the unit of work here.
 *
 * Exclusions are applied HERE, not by the caller: `excludePaths` governs the
 * whole graph (docs/octograph.md, "Exclusions apply to the whole graph"), and
 * a changed path that is not in the graph cannot produce a co-change row
 * anyway. Filtering here keeps the reported `changed` list honest about what
 * was actually analysed.
 */
export function changedPaths(
  repoRoot: string,
  scope: DiffScope,
  base: string,
  excludePaths: readonly string[],
): string[] {
  const uncommitted = (): string[] => [
    ...porcelainPaths(git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all"])),
  ];

  let paths: string[];
  switch (scope.kind) {
    case "staged":
      paths = nulList(git(repoRoot, ["diff", "--name-only", "-z", "--cached"]));
      break;
    case "worktree":
      paths = uncommitted();
      break;
    case "branch": {
      const mergeBase = git(repoRoot, ["merge-base", base, "HEAD"])?.trim();
      const committed =
        mergeBase === undefined || mergeBase === ""
          ? []
          : nulList(git(repoRoot, ["diff", "--name-only", "-z", `${mergeBase}..HEAD`]));
      paths = [...committed, ...uncommitted()];
      break;
    }
  }

  const kept = new Set(paths.filter((p) => !isExcludedPath(p, excludePaths)));
  return [...kept].sort(compare);
}
