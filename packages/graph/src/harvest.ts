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

/** Read a repo's history into commits, newest first. */
export function harvest(repoRoot: string, opts: HarvestOptions = {}): Commit[] {
  const maxFiles = opts.maxCommitFiles ?? 50;
  const args = ["log", "--no-merges", "--name-only", `--pretty=format:${RECORD}%H %at`];
  if (opts.since) args.push(`--since=${opts.since}`);

  const raw = execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
    encoding: "utf8",
  });

  const out: Commit[] = [];
  for (const block of raw.split(RECORD)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const header = lines[0];
    if (!header) continue;
    const [sha, at] = header.trim().split(" ");
    if (!sha || !at) continue;
    const files = [...new Set(lines.slice(1).filter((l) => l.length > 0))];
    if (files.length < 2 || files.length > maxFiles) continue;
    out.push({ sha, files, timestamp: Number(at) * 1000 });
  }
  return out;
}
