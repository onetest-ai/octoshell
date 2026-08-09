import { relative, resolve, sep } from "node:path";

/**
 * Resolve a path declared by repo content, or null if it escapes the root.
 *
 * Repo content — a workspace manifest, a tool's output file — must not be able
 * to point this package at a location outside the repo: `packages: ['../*']`
 * would otherwise enumerate the repo's siblings and land their names in a
 * committed artifact.
 *
 * Pure string math; it never touches the filesystem, so it is equally valid for
 * a path naming a file that does not exist.
 */
export function insideRepo(repoRoot: string, rel: string): string | null {
  const root = resolve(repoRoot);
  const abs = resolve(root, rel);
  return abs === root || abs.startsWith(`${root}${sep}`) ? abs : null;
}

/**
 * Normalize a path declared by repo content to the one namespace the rest of
 * this package speaks: a repo-relative, forward-slash-separated path, exactly
 * as `harvest` reads them out of git. Null if it escapes the root, or if it
 * names the root itself rather than a file inside it.
 *
 * Both halves matter to a caller mapping paths through `Spine.moduleOf`. An
 * absolute path left as-is yields a module named for the *checkout location*
 * (`/Users/<whoever>`), which differs per machine and so cannot appear in a
 * committed artifact; an escaping path yields one named `../..`.
 */
export function repoRelative(repoRoot: string, path: string): string | null {
  const abs = insideRepo(repoRoot, path);
  if (abs === null) return null;
  const rel = relative(resolve(repoRoot), abs);
  if (rel === "") return null;
  return rel.split(sep).join("/");
}
