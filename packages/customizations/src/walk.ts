import { readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_MAX_ITEMS, type ReaderContext } from "./types.js";

/**
 * Iterative depth-first walk of `root`, skipping `ctx.skipDirs` and symlink loops, collecting
 * files for which `match(rel, name)` is true. Stops once `ctx.maxItems` matches are collected.
 */
export function collectFiles(
  root: string,
  ctx: Pick<ReaderContext, "skipDirs" | "maxItems">,
  match: (rel: string, name: string) => boolean,
): { abs: string; rel: string }[] {
  const max = ctx.maxItems ?? DEFAULT_MAX_ITEMS;
  const out: { abs: string; rel: string }[] = [];
  const stack: string[] = [root];
  const seen = new Set<string>();
  // Seed the seen-set with the root's real path so a subdir symlinked back to root can't loop.
  try {
    seen.add(realpathSync(root));
  } catch {
    /* root unreachable — the loop will simply find nothing */
  }
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= max) break;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (ctx.skipDirs.has(e.name)) continue;
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        stack.push(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs);
        if (match(rel, e.name)) out.push({ abs, rel });
      }
    }
  }
  return out;
}
