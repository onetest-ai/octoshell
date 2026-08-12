import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { readGraphify } from "./graphify.js";
import { insideRepo } from "./paths.js";
import type { ModuleEdge } from "./rollup.js";

export interface Spine {
  source: "graphify" | "manifests" | "directories";
  modules: string[];
  moduleOf(path: string): string;
  /** Directed module dependencies. Empty unless the source supplies them. */
  imports: ModuleEdge[];
}

/**
 * The `packages:` list of a pnpm workspace file, via a real YAML parser.
 *
 * Scoped to that one key. A `pnpm-workspace.yaml` holds several other
 * list-shaped keys — `onlyBuiltDependencies` (which pnpm 10 writes on its
 * own), `ignoredBuiltDependencies`, `neverBuiltDependencies`,
 * `publicHoistPattern` — and reading any of those as package globs turns a
 * build dependency's *name* into a module root. In a repo with a `core/`
 * directory, `onlyBuiltDependencies: [core]` would then collapse every
 * `core/**` file into one module instead of `core/<sub>`, and that wrong
 * boundary would propagate silently into the committed artifact through
 * `rollUp`, which drops intra-module edges. Reading the parsed document's
 * `packages` key directly — rather than re-implementing that scoping with
 * more string matching — makes that a structural property instead of a
 * regex accident.
 *
 * Never throws: a malformed document, or one whose top level or `packages`
 * key isn't shaped as expected, degrades to "no globs found" so the caller
 * falls through to the next spine tier instead of taking the whole map down.
 */
function pnpmPackageGlobs(text: string): string[] {
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const packages = (doc as Record<string, unknown>).packages;
  if (!Array.isArray(packages)) return [];
  return packages.filter((item): item is string => typeof item === "string");
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * A dangling symlink under `packages/` — a stale worktree link, a removed local
 * dependency — must not take the whole map down: `statSync` follows the link and
 * throws ENOENT.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Single-package manifests that mark a directory as its own module, if found in bulk. */
const MANIFEST_MARKERS = ["go.mod", "Cargo.toml", "pyproject.toml"];

/** Directories the walk never descends into, even bounded by depth. */
const IGNORED_DIR_NAMES = new Set(["node_modules", "vendor", ".git", "dist", "build", "target"]);

/** How many directory levels below the repo root {@link discoverManifestRoots} will look. */
const MANIFEST_SCAN_MAX_DEPTH = 3;

/**
 * Directories that carry a `go.mod`, `Cargo.toml`, or `pyproject.toml`, found by
 * walking the tree (bounded depth, common noise directories skipped).
 *
 * A lone root-level marker is a fact about the repo, not a boundary set: every
 * file would map to `"."`, `rollUp` would drop every edge as intra-module (all
 * of them intra-`"."`), and the map would render one module with no
 * dependencies. Only report roots once there are two or more real modules to
 * draw a boundary between — callers ignore a single hit.
 */
function discoverManifestRoots(repoRoot: string): string[] {
  const found: string[] = [];

  function walk(relDir: string, depth: number): void {
    const abs = insideRepo(repoRoot, relDir);
    if (abs === null) return;
    if (MANIFEST_MARKERS.some((marker) => existsSync(join(abs, marker)))) found.push(relDir);
    if (depth >= MANIFEST_SCAN_MAX_DEPTH) return;
    for (const entry of readdirSafe(abs)) {
      if (entry.startsWith(".") || IGNORED_DIR_NAMES.has(entry)) continue;
      if (isDirectory(join(abs, entry))) {
        walk(relDir === "." ? entry : `${relDir}/${entry}`, depth + 1);
      }
    }
  }

  walk(".", 0);
  return found;
}

/** The real subdirectories of a repo-relative path, or `[]` if it isn't a directory. */
function subdirectories(repoRoot: string, relDir: string): string[] {
  const abs = insideRepo(repoRoot, relDir);
  if (abs === null) return [];
  return readdirSafe(abs).filter((entry) => isDirectory(join(abs, entry)));
}

/**
 * Expand a workspace glob into concrete repo-relative directories.
 *
 * Supports exactly the shape pnpm workspace globs document: a path made of
 * literal segments and zero or more standalone `*` segments, each `*`
 * matching any one directory name at that level. That covers a single
 * wildcard at the end (`packages` then a lone `*`, the original shape here)
 * and repeated wildcards nested deeper (`services`, `*`, `*` again) alike.
 * Each `*` is resolved by listing real directories, so a wildcard over a
 * path that doesn't exist yields no roots rather than a literal `*` string.
 *
 * Deliberately NOT supported — a full glob engine is a tarpit, and these
 * are not shapes pnpm's own docs use:
 *  - a recursive, any-depth wildcard segment
 *  - a partial-segment wildcard, e.g. `apps` + a dash + `service`, or a
 *    `pkg-` prefix followed by a wildcard
 *  - brace or bracket expansion, e.g. `{a,b}` or `[abc]`
 * A glob using one of these is treated as a literal path (matching the
 * pre-existing behavior for any non-wildcard segment): it will not resolve
 * to a real directory, so it contributes no files under `moduleOf` — never
 * a crash, just a boundary that quietly matches nothing.
 */
function expandGlob(repoRoot: string, glob: string): string[] {
  let bases = ["."];
  for (const segment of glob.split("/")) {
    if (segment === "*") {
      const next: string[] = [];
      for (const base of bases) {
        for (const entry of subdirectories(repoRoot, base)) {
          next.push(base === "." ? entry : `${base}/${entry}`);
        }
      }
      bases = next;
    } else {
      bases = bases.map((base) => (base === "." ? segment : `${base}/${segment}`));
    }
  }
  return bases.filter((rel) => rel !== "." && insideRepo(repoRoot, rel) !== null);
}

/** Directories a workspace manifest names, e.g. `packages/*` -> packages/one, packages/two. */
function workspaceRoots(repoRoot: string): string[] {
  const globs: string[] = [];

  const ws = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(ws)) {
    try {
      globs.push(...pnpmPackageGlobs(readFileSync(ws, "utf8")));
    } catch {
      /* unreadable manifest is not fatal — fall through to directories */
    }
  }

  const pkg = join(repoRoot, "package.json");
  if (existsSync(pkg)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
      const w = (parsed as { workspaces?: unknown }).workspaces;
      const list = Array.isArray(w) ? w : (w as { packages?: unknown })?.packages;
      if (Array.isArray(list)) for (const g of list) if (typeof g === "string") globs.push(g);
    } catch {
      /* a malformed manifest is not fatal — fall through to directories */
    }
  }

  const out: string[] = [];
  for (const glob of globs) {
    // `!pkg/private` is an exclusion, never a root of its own.
    if (glob.startsWith("!")) continue;
    out.push(...expandGlob(repoRoot, glob));
  }

  // An explicit workspace manifest already answered the question; only fall
  // back to marker discovery when it found nothing.
  if (out.length === 0) {
    const markerRoots = discoverManifestRoots(repoRoot);
    if (markerRoots.length > 1) out.push(...markerRoots);
  }

  return [...new Set(out)].sort();
}

/**
 * The bucket name for a root-level file (no `/` in its path) under the
 * two-segment convention.
 *
 * A sentinel, not a path: it can never collide with a real repo-relative
 * module boundary, because a colliding real path would require a literal
 * directory named `(repo root)` — and parens are not a shape any of the
 * boundary sources this function ever sees (workspace globs, manifest
 * directories, plain directory names) can produce from a repo-relative walk.
 * Deliberately not `"."` — that reads as a relative-path fragment (and this
 * file uses literal `"."` elsewhere for exactly that, unrelated,
 * filesystem-bookkeeping purpose in `discoverManifestRoots`/`expandGlob`/
 * `workspaceRoots`), where a human reading a rendered module heading or edge
 * endpoint would misread it as "no module" rather than "the repo root is
 * itself a module".
 */
const ROOT_MODULE = "(repo root)";

/** Two path segments: `src/host/x.ts` -> `src/host`. */
function twoSegmentModule(path: string): string {
  const parts = path.split("/");
  return parts.length <= 1 ? ROOT_MODULE : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

/**
 * Group harvested files by the module the spine's OWN `moduleOf` names for
 * them — the authoritative answer to "which module does this file belong
 * to", independent of any downstream clustering.
 *
 * Authoritative about IDENTITY, not complete about MEMBERSHIP: `files` is
 * `harvest`'s output, which only ever contains a path that appeared in an
 * analysable commit touching two or more files (see `PairTable.files`). A
 * file touched only by single-file commits has a real module identity —
 * `moduleOf` will name one for it — but never enters `files` at all, so it
 * never shows up as anyone's member here. The same partial-not-total gap
 * `render.ts` states explicitly for the map's per-module count line
 * ("files never co-changed with another file: omitted below").
 *
 * `Spine.modules` below and `analyze`'s module-identity backstop (the fix for
 * the defect where a declared module could vanish from `Analysis.modules`
 * while its `moduleEdges` endpoint survived — `moduleEdges` is keyed by
 * `moduleOf` alone via `rollUp`/`readGraphify`, oblivious to any clustering),
 * plus `analyze`'s `ModuleSummary.members` (which module identity, not
 * clustering, now decides — see the `members lists a Louvain community's
 * files` bug), all read "what is a module, and what does it contain" through
 * this and only this, so they cannot diverge into independent derivations the
 * way they did before.
 */
export function filesByModule(
  files: string[],
  moduleOf: (path: string) => string,
): Map<string, number[]> {
  const byName = new Map<string, number[]>();
  files.forEach((path, id) => {
    const name = moduleOf(path);
    const list = byName.get(name);
    if (list) list.push(id);
    else byName.set(name, [id]);
  });
  return byName;
}

export function declaredSpine(repoRoot: string, files: string[]): Spine {
  // 1. Pick the best available module BOUNDARY.
  const roots = workspaceRoots(repoRoot);
  const manifestBased = roots.length > 1 || (roots.length === 1 && roots[0] !== ".");

  let moduleOf: (path: string) => string;
  if (manifestBased) {
    const sorted = [...roots].sort((a, b) => b.length - a.length);
    moduleOf = (path: string): string =>
      sorted.find((r) => path === r || path.startsWith(`${r}/`)) ?? twoSegmentModule(path);
  } else {
    moduleOf = twoSegmentModule;
  }

  // 2. Independently, pick the best available EDGE source. Graphify only wins
  //    on edges — using its presence to also downgrade boundaries to the crude
  //    two-segment heuristic would make the highest-fidelity tier produce the
  //    worst module names in any repo whose packages sit deeper than two
  //    segments (`services/team-a/api-gateway`).
  const imports = readGraphify(repoRoot, moduleOf) ?? [];
  const source: Spine["source"] =
    imports.length > 0 ? "graphify" : manifestBased ? "manifests" : "directories";

  // The module universe is every module the spine can NAME, from either half
  // above: one that a harvested file lives in, OR one that a declared import
  // edge points at. The second half is not decoration. `files` is what
  // `harvest` saw — commits inside the `--since` window, under the mega-commit
  // cap, touching two or more paths — while Graphify indexes the whole tree, so
  // a package that simply had no analysable churn in that window has no
  // harvested file and yet is a perfectly real endpoint in `imports`. Deriving
  // this list from `filesByModule` alone made it disagree with `imports`
  // whenever that happened, and both consumers then failed the same way:
  // `layerRanks` silently DROPPED every edge touching the missing module (so a
  // cycle running through it vanished and everything downstream mis-ranked),
  // and `analyze` rendered a dependency line to a module with no heading of its
  // own — the identical dangling-reference defect already fixed once on the
  // co-change branch of `moduleEdges`, still open on this one.
  const names = new Set(filesByModule(files, moduleOf).keys());
  for (const e of imports) {
    names.add(e.from);
    names.add(e.to);
  }
  const modules = [...names].sort();
  return { source, modules, moduleOf, imports };
}
