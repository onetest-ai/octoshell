import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths, diffImpact } from "../src/diff-impact.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import type { Edge } from "../src/weights.js";
import type { VaultNote } from "../src/vault.js";

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

const FILES = ["a.ts", "b.ts", "c.ts", "d.test.ts", "e.ts"];
const edge = (a: number, b: number, npmi: number, support: number): Edge => ({
  a,
  b,
  npmi,
  support,
  confidence: 0.5,
});

describe("diffImpact", () => {
  it("returns nothing for an empty changed set", () => {
    expect(diffImpact([], [], FILES, [])).toEqual({ changed: [], source: [], tests: [] });
  });

  it("drops rows that are themselves in the changed set", () => {
    // a<->b, and BOTH are changed: b is not something you might have missed.
    const edges = [edge(0, 1, 0.9, 10)];
    expect(diffImpact(["a.ts", "b.ts"], edges, FILES, []).source).toEqual([]);
  });

  it("partitions rows into source and tests", () => {
    const edges = [edge(0, 2, 0.9, 10), edge(0, 3, 0.8, 10)];
    const answer = diffImpact(["a.ts"], edges, FILES, []);
    expect(answer.source.map((r) => r.path)).toEqual(["c.ts"]);
    expect(answer.tests.map((r) => r.path)).toEqual(["d.test.ts"]);
  });

  it("records every changed path that pulled a row in", () => {
    // c.ts co-changes with both a.ts and b.ts.
    const edges = [edge(0, 2, 0.9, 10), edge(1, 2, 0.9, 10)];
    const answer = diffImpact(["a.ts", "b.ts"], edges, FILES, []);
    expect(answer.source[0]?.predictedBy).toEqual(["a.ts", "b.ts"]);
  });

  it("ranks a row two changed files predict above an equally scored row only one predicts", () => {
    // z.ts pulled by a.ts and b.ts; e.ts pulled by a.ts alone, same weight —
    // and "e.ts" < "z.ts" alphabetically, so the shared `compare` tiebreak
    // alone would put e.ts FIRST. Only the predictedBy-length tiebreak (which
    // runs before `compare`) puts the two-changed-file row ahead of it; delete
    // that term and this assertion flips, which is the point.
    const files = [...FILES, "z.ts"];
    const edges = [edge(0, 5, 0.9, 10), edge(1, 5, 0.9, 10), edge(0, 4, 0.9, 10)];
    const answer = diffImpact(["a.ts", "b.ts"], edges, files, []);
    expect(answer.source.map((r) => r.path)).toEqual(["z.ts", "e.ts"]);
  });

  it("attaches cited vault notes to a row", () => {
    // `citedPaths` deliberately never matches a bare basename (see
    // vault.test.ts "drops a bare basename — a citation must be unambiguous"),
    // so the note body and the graph's file paths need a directory segment
    // for a citation to be possible at all — a flat `a.ts`/`c.ts` graph could
    // never produce a `cited` match, no matter what `diffImpact` does.
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const notes: VaultNote[] = [
      {
        note: "architecture/pair.md",
        name: "pair",
        description: "a and c move together",
        verified: "2026-08-13",
        body: "the pair is src/a.ts and src/c.ts",
      },
    ];
    const answer = diffImpact(["src/a.ts"], [edge(0, 2, 0.9, 10)], files, notes);
    expect(answer.source[0]?.notes).toEqual([
      {
        path: "src/c.ts",
        note: "architecture/pair.md",
        description: "a and c move together",
        mode: "cited",
        confidence: 1,
      },
    ]);
  });

  it("caps source and tests independently at the limit", () => {
    const edges = [edge(0, 1, 0.9, 10), edge(0, 2, 0.8, 10), edge(0, 3, 0.7, 10)];
    const answer = diffImpact(["a.ts"], edges, FILES, [], 1);
    expect(answer.source).toHaveLength(1);
    expect(answer.tests).toHaveLength(1);
  });

  it("ignores a changed path that is not in the co-change graph", () => {
    expect(diffImpact(["unknown.ts"], [edge(0, 1, 0.9, 10)], FILES, []).source).toEqual([]);
  });
});
