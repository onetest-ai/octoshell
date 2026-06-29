import { existsSync } from "node:fs";
import { join } from "node:path";

const BUSY_MARKERS = [
  "index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG",
  "rebase-merge", "rebase-apply",
];

/** True when no git operation is mid-flight under `repoRoot`. A missing `.git` is quiescent. */
export function isGitQuiescent(repoRoot: string): boolean {
  const gitDir = join(repoRoot, ".git");
  if (!existsSync(gitDir)) return true;
  return !BUSY_MARKERS.some((m) => existsSync(join(gitDir, m)));
}
