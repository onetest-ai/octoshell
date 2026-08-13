import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths } from "../src/diff-impact.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** A repo with `main` at one commit and a branch two commits ahead. */
function repoWithBranch(): string {
  const root = mkdtempClean("diff-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  write(root, "src/base.ts", "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  write(root, "src/one.ts", "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  write(root, "src/two.ts", "two\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "two");
  return root;
}

describe("changedPaths", () => {
  it("branch scope returns every path the branch changed against the base", () => {
    const root = repoWithBranch();
    expect(changedPaths(root, { kind: "branch" }, "main", [])).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
  });

  it("branch scope also includes uncommitted work", () => {
    const root = repoWithBranch();
    write(root, "src/three.ts", "three\n");
    git(root, "add", "-A");
    write(root, "src/four.ts", "four\n"); // untracked, unstaged
    expect(changedPaths(root, { kind: "branch" }, "main", [])).toEqual([
      "src/four.ts",
      "src/one.ts",
      "src/three.ts",
      "src/two.ts",
    ]);
  });

  it("staged scope returns only what is in the index", () => {
    const root = repoWithBranch();
    write(root, "src/staged.ts", "s\n");
    git(root, "add", "src/staged.ts");
    write(root, "src/loose.ts", "l\n");
    expect(changedPaths(root, { kind: "staged" }, "main", [])).toEqual(["src/staged.ts"]);
  });

  it("worktree scope returns uncommitted work only, not the branch's commits", () => {
    const root = repoWithBranch();
    write(root, "src/loose.ts", "l\n");
    expect(changedPaths(root, { kind: "worktree" }, "main", [])).toEqual(["src/loose.ts"]);
  });

  it("applies excludePaths, so the diff obeys the same exclusions as the graph", () => {
    const root = repoWithBranch();
    write(root, ".octobots/board.yaml", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "board");
    expect(changedPaths(root, { kind: "branch" }, "main", [".octobots/"])).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
  });

  it("returns an empty list when the base ref does not exist, rather than throwing", () => {
    const root = repoWithBranch();
    expect(changedPaths(root, { kind: "branch" }, "no-such-ref", [])).toEqual([]);
  });

  it("returns an empty list outside a git repository, rather than throwing", () => {
    expect(changedPaths(mkdtempClean("nogit-"), { kind: "branch" }, "main", [])).toEqual([]);
  });

  it("deduplicates a path that is both committed on the branch and modified in the worktree", () => {
    const root = repoWithBranch();
    write(root, "src/one.ts", "one, edited\n");
    expect(changedPaths(root, { kind: "branch" }, "main", [])).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
  });

  // `worktree`, not `staged`: only `uncommitted()` (`git status --porcelain -z`)
  // ever calls `porcelainPaths` — `staged` routes through `git diff --name-only
  // -z --cached`, which collapses a rename into a single record with no old-
  // path companion, so it never reaches the skip logic this test exists to
  // exercise. `git mv` is picked up by `uncommitted()` whether or not it is
  // staged (git mv stages it), so `worktree` scope is enough on its own.
  it("consumes the OLD-path record of a rename and keeps only the new path", () => {
    const root = repoWithBranch();
    git(root, "mv", "src/one.ts", "src/one-renamed.ts");
    expect(changedPaths(root, { kind: "worktree" }, "main", [])).toEqual(["src/one-renamed.ts"]);
  });
});
