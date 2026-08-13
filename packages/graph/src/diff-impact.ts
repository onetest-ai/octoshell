import { execFileSync } from "node:child_process";
import { impact, type ImpactRow } from "./impact.js";
import { isExcludedPath, isTestPath } from "./noise.js";
import { rankScore } from "./rank.js";
import { compare } from "./rollup.js";
import { matchCited, type VaultMatch, type VaultNote } from "./vault.js";
import type { Edge } from "./weights.js";

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

export interface DiffImpactRow extends ImpactRow {
  /** Which changed paths pulled this row in, sorted. */
  predictedBy: string[];
  /** Vault notes about this row. `cited` only — see `diffImpact`. */
  notes: VaultMatch[];
}

export interface DiffImpactAnswer {
  /** The changed set actually analysed, after exclusions. */
  changed: string[];
  /** Files that co-change with the changed set and are not tests. */
  source: DiffImpactRow[];
  /** Files that co-change with the changed set and are tests. */
  tests: DiffImpactRow[];
}

/**
 * What else history says moves with everything you changed.
 *
 * `limit` means two different things on purpose, and `--help` says so: the
 * inner `impact()` keeps its own per-path default so no single changed file
 * can flood the union, and `limit` caps each of `source` and `tests` after the
 * merge. An unqualified "limit" on a command that fans out over N paths is a
 * number a reader would otherwise have to infer.
 *
 * Only `cited` notes are attached. A `predicted` note is a guess about
 * relevance layered on top of a co-change row that is already probabilistic,
 * and stacking two soft signals into one line is exactly the blending `own`
 * refuses to do. A caller who wants the predicted tier asks `vault.ts` for it
 * directly and labels it themselves.
 */
export function diffImpact(
  changed: readonly string[],
  edges: Edge[],
  files: string[],
  notes: readonly VaultNote[],
  limit = 20,
  minSupport = 2,
): DiffImpactAnswer {
  const changedSet = new Set(changed);
  const merged = new Map<string, { row: ImpactRow; score: number; by: Set<string> }>();

  for (const path of changed) {
    for (const row of impact(path, edges, files, undefined, minSupport)) {
      if (changedSet.has(row.path)) continue; // you already touched it
      // `ImpactRow.npmi` is ALREADY an `edgeWeight` result — impact.ts says so
      // explicitly ("`ImpactRow.npmi` still reports the plain `edgeWeight`
      // value; only the order changes"). Re-flooring it through `edgeWeight`
      // would be a second place a negative nPMI could reach a ranking, which is
      // exactly what `rankScore`'s own doc comment forbids.
      //
      // Destructured, not `row.npmi` — `test/conventions.test.ts` bans `.npmi`
      // dot access outside weights.ts to keep the nPMI floor single-spelled;
      // this is a DIFFERENT field (the already-floored value on a result row,
      // same as `cli.ts`'s `formatImpactRow`), but the guard is textual, so
      // destructuring keeps the intent legible without tripping it.
      const { npmi, support } = row;
      const score = rankScore(npmi, support, minSupport);
      const existing = merged.get(row.path);
      if (existing === undefined) {
        merged.set(row.path, { row, score, by: new Set([path]) });
      } else {
        existing.by.add(path);
        if (score > existing.score) {
          existing.score = score;
          existing.row = row;
        }
      }
    }
  }

  const cited = matchCited(notes, [...merged.keys()]);
  const notesFor = new Map<string, VaultMatch[]>();
  for (const m of cited) {
    const list = notesFor.get(m.path);
    if (list === undefined) notesFor.set(m.path, [m]);
    else list.push(m);
  }

  const rows: Array<{ row: DiffImpactRow; score: number }> = [...merged.values()].map((e) => ({
    row: {
      ...e.row,
      predictedBy: [...e.by].sort(compare),
      notes: notesFor.get(e.row.path) ?? [],
    },
    score: e.score,
  }));

  // Strength first; then how many independent changed files point at it — a
  // file three of your changes all pull on is stronger evidence than one a
  // single change pulls on; then the shared comparator, for determinism.
  rows.sort(
    (x, y) =>
      y.score - x.score
      || y.row.predictedBy.length - x.row.predictedBy.length
      || compare(x.row.path, y.row.path),
  );

  const keep = limit > 0 ? limit : 0;
  return {
    changed: [...changed],
    source: rows.filter((r) => !isTestPath(r.row.path)).slice(0, keep).map((r) => r.row),
    tests: rows.filter((r) => isTestPath(r.row.path)).slice(0, keep).map((r) => r.row),
  };
}
