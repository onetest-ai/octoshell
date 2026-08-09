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

// ASCII Record Separator: guaranteed not to collide with a sha, a timestamp,
// or a file path, unlike a plain space (which also sits between %H and %at
// in the header line below and would otherwise split the header apart).
const RECORD = "\x1e";

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
  const args = ["log", "--no-merges", "--name-only", "-z", `--pretty=format:${RECORD}%H %at`];
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
    const [sha, at] = block.slice(0, end).trim().split(" ");
    if (!sha || !at) continue;
    const files = [...new Set(block.slice(end + 1).split("\0").filter((p) => p.length > 0))];
    if (files.length < 2 || files.length > maxFiles) continue;
    out.push({ sha, files, timestamp: Number(at) * 1000 });
  }
  return out;
}
