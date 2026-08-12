import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * The repo root through the same resolved namespace {@link insideRepo} and
 * {@link repoRelative} both compare against.
 *
 * The repo root is expected to exist (it is the checkout under analysis), so
 * this always attempts to resolve it — unconditionally, unlike the candidate
 * path in `insideRepo` below. That matters even when repo CONTENT holds no
 * symlink at all: the OS's own temp-dir chain can (macOS's `/var` ->
 * `/private/var`, which every path under the system temp dir passes
 * through), and comparing an unresolved root against a resolved candidate — or
 * vice versa — produces a false escape on every such repo. Falling back to
 * the unresolved value on the off chance the root itself does not exist keeps
 * this from taking the whole check down over that edge case.
 */
function resolvedRoot(repoRoot: string): string {
  const root = resolve(repoRoot);
  return tryRealpath(root) ?? root;
}

/**
 * Resolve a path declared by repo content, or null if it escapes the root.
 *
 * Repo content — a workspace manifest, a tool's output file — must not be able
 * to point this package at a location outside the repo: `packages: ['../*']`
 * would otherwise enumerate the repo's siblings and land their names in a
 * committed artifact.
 *
 * Threat model: octograph is pointed at checkouts nobody on this team wrote,
 * so the repo's own content — including a symlink placed somewhere inside
 * it — must be treated as potentially hostile input, not trusted structure.
 * String math over `path.resolve` alone is not enough: a symlink INSIDE the
 * repo that points OUTSIDE it passes that check (the string itself never
 * leaves the root) and is only followed later, unguarded, by `statSync`/
 * `readdirSync` in spine.ts's directory walks — by which point this function
 * has already vouched for it. Resolve the REAL path (following symlinks) for
 * both the root and the candidate before comparing, so an escape via a
 * symlink component is caught here, at the one seam every caller trusts.
 *
 * The candidate is built ON TOP of the already-resolved root (`resolve(root,
 * rel)`), so it starts out consistent with `root`'s namespace even before any
 * further resolution — resolving `abs` past that is then only about symlinks
 * `rel` itself introduces, and is conditional on the candidate existing: a
 * real package directory reached through a symlink is an ordinary monorepo
 * pattern (a workspace tool symlinking `node_modules/@scope/pkg` back to
 * `packages/pkg`, say) and must still resolve as inside the repo if its REAL
 * target is inside it — which is exactly why this resolves-then-compares
 * rather than rejecting any path with a symlink component outright.
 *
 * The candidate need not exist as a WHOLE — a path named by repo content
 * (a Graphify node, say) can name a file deleted after the tool that produced
 * it ran — so a plain `realpathSync(abs)` would throw ENOENT for a perfectly
 * legitimate in-repo path and force a fallback to the unresolved string,
 * silently re-opening the symlink-escape hole for exactly the paths that
 * don't happen to exist. `resolveAsFarAsExists` resolves the deepest EXISTING
 * ancestor and re-appends whatever suffix does not exist: symlinks can only
 * live on the part of the path that exists, so this is exact, not
 * approximate, and still preserves "equally valid for a path naming a file
 * that does not exist" for the case where nothing below the root exists at
 * all (the ancestor search bottoms out at `root` itself).
 */
export function insideRepo(repoRoot: string, rel: string): string | null {
  const root = resolvedRoot(repoRoot);
  const abs = resolve(root, rel);
  const candidate = resolveAsFarAsExists(abs);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

/** `fs.realpathSync`, returning `null` for a path that does not exist (or is
 *  otherwise unreadable) rather than throwing. */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolve `path` following symlinks as far as an existing ancestor allows,
 * re-appending whatever suffix does not exist on disk.
 *
 * Walks upward one path segment at a time until `realpathSync` succeeds, then
 * rejoins the segments that were shed along the way onto that resolved
 * ancestor. Nothing beyond the resolved ancestor can be a symlink — nothing
 * beyond it exists yet — so the result is exact for the containment check in
 * `insideRepo`, not a heuristic. The walk always terminates: `dirname` of the
 * filesystem root returns itself, and a real root always resolves.
 */
function resolveAsFarAsExists(path: string): string {
  const tail: string[] = [];
  let dir = path;
  for (;;) {
    const real = tryRealpath(dir);
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(dir);
    if (parent === dir) return path; // filesystem root itself did not resolve — give up cleanly
    tail.unshift(basename(dir));
    dir = parent;
  }
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
 *
 * Computes the relative path against the SAME resolved root `insideRepo`
 * compared `abs` against — not a freshly unresolved `resolve(repoRoot)` —
 * or the two would disagree the moment the root sits behind any symlink
 * (repo content or the OS temp-dir chain alike), producing a `../../..`-laden
 * result instead of the clean repo-relative path a real match earned.
 */
export function repoRelative(repoRoot: string, path: string): string | null {
  const abs = insideRepo(repoRoot, path);
  if (abs === null) return null;
  const rel = relative(resolvedRoot(repoRoot), abs);
  if (rel === "") return null;
  return rel.split(sep).join("/");
}
