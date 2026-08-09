import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleEdge } from "./rollup.js";

export interface Spine {
  source: "graphify" | "manifests" | "directories";
  modules: string[];
  moduleOf(path: string): string;
  /** Directed module dependencies. Empty unless the source supplies them. */
  imports: ModuleEdge[];
}

/** Directories a workspace manifest names, e.g. `packages/*` -> packages/one, packages/two. */
function workspaceRoots(repoRoot: string): string[] {
  const globs: string[] = [];

  const ws = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(ws)) {
    // Deliberately not a YAML parse: we need one list of strings, and the
    // package must stay dependency-free.
    for (const line of readFileSync(ws, "utf8").split("\n")) {
      const m = /^\s*-\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
      if (m?.[1]) globs.push(m[1]);
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
    if (glob.endsWith("/*")) {
      const base = glob.slice(0, -2);
      const dir = join(repoRoot, base);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (statSync(join(dir, entry)).isDirectory()) out.push(`${base}/${entry}`);
      }
    } else {
      out.push(glob);
    }
  }

  // Single-package repos with their own manifest still count as one module.
  for (const marker of ["go.mod", "Cargo.toml", "pyproject.toml"]) {
    if (out.length === 0 && existsSync(join(repoRoot, marker))) out.push(".");
  }

  return [...new Set(out)].sort();
}

/** Two path segments: `src/host/x.ts` -> `src/host`. */
function twoSegmentModule(path: string): string {
  const parts = path.split("/");
  return parts.length <= 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

export function declaredSpine(repoRoot: string, files: string[]): Spine {
  const roots = workspaceRoots(repoRoot);

  if (roots.length > 1 || (roots.length === 1 && roots[0] !== ".")) {
    const sorted = [...roots].sort((a, b) => b.length - a.length);
    const moduleOf = (path: string): string =>
      sorted.find((r) => path === r || path.startsWith(`${r}/`)) ?? twoSegmentModule(path);
    const modules = [...new Set(files.map(moduleOf))].sort();
    return { source: "manifests", modules, moduleOf, imports: [] };
  }

  const moduleOf = twoSegmentModule;
  const modules = [...new Set(files.map(moduleOf))].sort();
  return { source: "directories", modules, moduleOf, imports: [] };
}
