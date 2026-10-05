import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./tmpdir.js";

const REPO_OCTOBOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".octobots");

/**
 * Real boards for tests (campaign notes § Test conventions, rule 2): every `.octobots` directory
 * named in OCTOBOTS_BOARD_COPIES (colon-separated), else the repo's own `.octobots/`. Each is
 * copied into a scratch directory first, so a test never writes to the original. Never empty.
 */
export function realBoardCopies(): string[] {
  const named = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
  const sources = named.length > 0 ? named : [REPO_OCTOBOTS];
  return sources.map((src, i) => {
    const dest = join(mkdtempClean(`real-board-${i}-`), ".octobots");
    cpSync(src, dest, { recursive: true });
    return dest;
  });
}

/** Every file at or under a `workflows/` directory beneath `root`, as relative path -> sha256. */
export function workflowFileHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, inside: boolean): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, inside || e.name === "workflows");
      else if (inside && statSync(p).isFile()) out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(root)) walk(root, false);
  return out;
}
