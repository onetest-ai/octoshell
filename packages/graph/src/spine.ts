import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
 * The `packages:` list of a pnpm workspace file, without a YAML parser.
 *
 * Deliberately not a YAML parse: we need one list of strings, and the package
 * must stay dependency-free. But it *is* scoped to that one key. A
 * `pnpm-workspace.yaml` holds several other list-shaped keys —
 * `onlyBuiltDependencies` (which pnpm 10 writes on its own),
 * `ignoredBuiltDependencies`, `neverBuiltDependencies`, `publicHoistPattern` —
 * and reading every `- item` line in the file turns a build dependency's *name*
 * into a module root. In a repo with a `core/` directory,
 * `onlyBuiltDependencies: [core]` then collapses every `core/**` file into one
 * module instead of `core/<sub>`, and that wrong boundary propagates silently
 * into the committed artifact through `rollUp`, which drops intra-module edges.
 */
function pnpmPackageGlobs(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^(---|\.\.\.)\s*$/.test(line)) {
      inPackages = false;
      continue;
    }
    // A key at column 0 opens (or closes) the section we care about.
    const key = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (key) {
      inPackages = key[1] === "packages";
      continue;
    }
    if (!inPackages) continue;
    // Quoted or bare item, with an optional trailing comment.
    const item = /^\s*-\s*(?:'([^']*)'|"([^"]*)"|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line);
    const value = item?.[1] ?? item?.[2] ?? item?.[3];
    if (value) globs.push(value);
  }
  return globs;
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
    if (glob.endsWith("/*")) {
      const base = glob.slice(0, -2);
      const dir = insideRepo(repoRoot, base);
      if (dir === null) continue;
      for (const entry of readdirSafe(dir)) {
        if (isDirectory(join(dir, entry))) out.push(`${base}/${entry}`);
      }
    } else if (insideRepo(repoRoot, glob) !== null) {
      out.push(glob);
    }
  }

  // An explicit workspace manifest already answered the question; only fall
  // back to marker discovery when it found nothing.
  if (out.length === 0) {
    const markerRoots = discoverManifestRoots(repoRoot);
    if (markerRoots.length > 1) out.push(...markerRoots);
  }

  return [...new Set(out)].sort();
}

/** Two path segments: `src/host/x.ts` -> `src/host`. */
function twoSegmentModule(path: string): string {
  const parts = path.split("/");
  return parts.length <= 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
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

  const modules = [...new Set(files.map(moduleOf))].sort();
  return { source, modules, moduleOf, imports };
}
