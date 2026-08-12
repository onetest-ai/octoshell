import { execFileSync } from "node:child_process";
import type { Commit } from "./types.js";

export interface HarvestOptions {
  /** Commits touching more files than this are dropped: rename sweeps and
   *  formatter runs assert coupling between every pair they touch, which is
   *  false and swamps the signal. */
  maxCommitFiles?: number;
  /** Passed through to `git log --since`. */
  since?: string;
}

/**
 * Record separator, emitted by the `%x00%x1e` at the head of the pretty format
 * below and split on here.
 *
 * The NUL is the load-bearing half. POSIX forbids exactly two bytes in a path:
 * `/` and NUL. An ASCII Record Separator alone appears in no sha and no
 * timestamp, but it *is* a byte a file name may legally carry — and a lone
 * `\x1e` sentinel is therefore forgeable. Verified against a real repo: a file
 * committed as
 *
 *     src/evil<0x1e>0000000000000000000000000000000000000000 1700000000\nphantom.ts
 *
 * made `harvest` return a commit with that 40-zero sha, a 2023 timestamp of the
 * committer's choosing, and `phantom.ts` — a file present in no tree — while
 * swallowing the real commit's record whole. Prefixing the sentinel with NUL
 * makes the boundary unforgeable rather than merely unlikely: the attacker can
 * write the `\x1e`, but cannot write the NUL that must precede it.
 */
const RECORD = "\0\x1e";

/** `%H %at` and nothing else — a cheap second gate on a malformed block. */
const HEADER = /^[0-9a-f]{40} \d+$/;

/**
 * Index of the byte that ends the `%H %at` header of a `git log` record.
 *
 * Under `-z` this repo's git terminates the header with `\n` and the file
 * names that follow with NUL, but the pretty header is documented as
 * "terminated by NUL" and some versions do exactly that. The header itself
 * contains neither byte, so the first occurrence of *either* ends it — which
 * is also why we must not split the whole block on `\n`: under `-z` a file
 * name may legally contain one.
 */
function headerEnd(block: string): number {
  const nl = block.indexOf("\n");
  const nul = block.indexOf("\0");
  if (nl < 0) return nul;
  if (nul < 0) return nl;
  return Math.min(nl, nul);
}

/** Read a repo's history into commits, newest first. */
export function harvest(repoRoot: string, opts: HarvestOptions = {}): Commit[] {
  const maxFiles = opts.maxCommitFiles ?? 50;
  // `-z` makes git emit NUL-separated *raw* path bytes. Without it git applies
  // `core.quotePath` and hands back C-quoted paths for anything non-ASCII —
  // `src/résumé.ts` arrives as `"src/r\303\251sum\303\251.ts"`, quotes and all,
  // which is not a path that exists on disk and would name a phantom node in
  // the committed artifact.
  const args = ["log", "--no-merges", "--name-only", "-z", "--pretty=format:%x00%x1e%H %at"];
  if (opts.since) args.push(`--since=${opts.since}`);

  const raw = execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
    encoding: "utf8",
  });

  const out: Commit[] = [];
  for (const block of raw.split(RECORD)) {
    const end = headerEnd(block);
    if (end < 0) continue;
    const header = block.slice(0, end);
    const [sha, at] = header.split(" ");
    if (sha === undefined || at === undefined || !HEADER.test(header)) continue;
    const files = [...new Set(block.slice(end + 1).split("\0").filter((p) => p.length > 0))];
    if (files.length < 2 || files.length > maxFiles) continue;
    out.push({ sha, files, timestamp: Number(at) * 1000 });
  }
  return out;
}

/** How much of this repository's history is squashed pull requests, and how
 *  much of that the mega-commit filter then discards. */
export interface SquashShape {
  /** Non-merge commits in the window. */
  total: number;
  /** Of those, ones whose subject looks like a squashed PR. */
  squashed: number;
  /** Squashed PRs large enough that `maxCommitFiles` dropped them entirely —
   *  the ones contributing NOTHING to the co-change graph. */
  droppedSquash: number;
  /** More than half the window is squashed PRs. */
  dominated: boolean;
}

/** GitHub, GitLab and Bitbucket all append the request number to a squashed
 *  subject. Matching the shape rather than a provider keeps this honest about
 *  what it is: a heuristic over commit subjects, not a fact from the forge. */
const SQUASH_SUBJECT = /\(#\d+\)$/;

/**
 * Diagnose whether thin co-change data is caused by squash-merging rather
 * than by a shallow clone — the two look identical from a commit count, and
 * only one of them has a fix.
 *
 * This exists because `doctor`'s advice was actively wrong on a squashed
 * repository: it told the reader to unshallow a clone that was already
 * complete. Measured on this repo, a seven-mission campaign of 102 commits
 * became one 147-file commit that `maxCommitFiles` then dropped, so the whole
 * campaign contributed nothing at all.
 *
 * Deliberately a *diagnosis* and not a recovery. The pre-squash commits are
 * fetchable from a forge's PR refs, but reconstructing them rebuilds — badly —
 * a grouping the Octobots board already records exactly, through a task's
 * merge SHA. Squashing costs the discovered half of the graph; it does not
 * touch the declared spine and it does not touch provenance.
 */
export function squashShape(repoRoot: string, opts: HarvestOptions = {}): SquashShape {
  const args = ["log", "--no-merges", "--format=%H %s"];
  if (opts.since) args.push(`--since=${opts.since}`);
  const raw = execFileSync("git", args, { cwd: repoRoot, maxBuffer: 1 << 28, encoding: "utf8" });

  const squashedShas = new Set<string>();
  let total = 0;
  for (const line of raw.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    total += 1;
    if (SQUASH_SUBJECT.test(line.slice(sp + 1).trim())) squashedShas.add(line.slice(0, sp));
  }

  // Dropped means "passed the two-file floor but failed the size ceiling" —
  // not "absent from the graph", which would also count every single-file
  // commit and overstate the damage.
  const sized = new Set(
    harvest(repoRoot, { ...opts, maxCommitFiles: Number.MAX_SAFE_INTEGER }).map((c) => c.sha),
  );
  const kept = new Set(harvest(repoRoot, opts).map((c) => c.sha));
  let droppedSquash = 0;
  for (const sha of squashedShas) if (sized.has(sha) && !kept.has(sha)) droppedSquash += 1;

  return {
    total,
    squashed: squashedShas.size,
    droppedSquash,
    dominated: squashedShas.size * 2 > total,
  };
}

/**
 * Whether git ignores `path` — used by `doctor` to notice that the directory
 * the graph artifact lands in will never be committed.
 *
 * `git check-ignore` exits 0 when a path IS ignored and 1 when it is not, so
 * a non-zero exit is an answer here rather than a failure. Any other failure
 * (not a repo, git missing) resolves to `false`: this backs an advisory
 * check, and guessing "ignored" on an unrelated error would produce a
 * confident recommendation about a file the caller may be committing fine.
 */
export function isIgnored(repoRoot: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
