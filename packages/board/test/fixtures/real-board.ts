import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

const REPO_OCTOBOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".octobots");

/** A scratch directory that removes itself when the test that created it finishes. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Real boards for tests (campaign notes, Test conventions rule 2): every `.octobots` directory named
 * in OCTOBOTS_BOARD_COPIES (colon-separated), else the repo's own `.octobots/`. Each is copied into a
 * scratch directory first, so a test never writes to the original. Never empty. The copy is returned
 * as the board directory itself (the folder holding `campaigns/`), named `.octobots`.
 */
export function realBoardCopies(): string[] {
  const named = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
  const sources = named.length > 0 ? named : [REPO_OCTOBOTS];
  return sources.map((src, i) => {
    const dest = join(scratchDir(`real-board-${i}-`), ".octobots");
    cpSync(src, dest, { recursive: true });
    return dest;
  });
}

/** Names of the campaign directories of a board directory. */
export function campaignDirs(board: string): string[] {
  const campaigns = join(board, "campaigns");
  return readdirSync(campaigns, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(campaigns, e.name));
}

/**
 * Boards built from what a CI checkout has: only TRACKED files. `git archive HEAD .octobots` into a
 * scratch directory (the working-tree `.octobots/` is gitignored, so it holds campaigns and files a
 * fresh checkout never sees), plus every `.octobots` named in OCTOBOTS_BOARD_COPIES. Each is a fresh
 * scratch copy named `.octobots`, so a test may add to it freely. Never empty.
 */
export function trackedBoardCopies(): string[] {
  const repoRoot = join(REPO_OCTOBOTS, "..");
  const extract = scratchDir("tracked-board-");
  const archive = execFileSync("git", ["archive", "HEAD", ".octobots"], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", extract], { input: archive });
  const named = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
  const extra = named.map((src, i) => {
    const dest = join(scratchDir(`named-board-${i}-`), ".octobots");
    cpSync(src, dest, { recursive: true });
    return dest;
  });
  return [join(extract, ".octobots"), ...extra];
}
