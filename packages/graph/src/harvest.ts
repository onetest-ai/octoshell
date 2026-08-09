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
