// Package the extension into an installable .vsix (NOT publishing).
//
// Self-contained: cleans stale webview output, rebuilds (esbuild host bundle + vite webview),
// then packages. The monorepo manifest uses a scoped name (@octoshell/vscode-extension) and has
// no `publisher`, both of which `vsce` rejects; esbuild already bundles every @octoshell/* dep
// into dist/extension.js (only `vscode` is external), so we package with --no-dependencies and
// ship no node_modules. The packaging-valid manifest is overlaid only around the vsce call and
// restored in a finally, so an error never leaves package.json patched.
//
// Usage: pnpm --filter @octoshell/vscode-extension package
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: extDir, stdio: "inherit" });

/**
 * Run a step whose failure must not stop the release. The price refreshes are the only such steps:
 * both leave the previous cached table in place when upstream is unreachable, so a stale table is
 * the worst outcome — and a stale table beats no VSIX. The two refreshers disagree on exit code
 * (the pack's CLI exits 1 so a user who asks for a refresh learns it failed), which is why
 * tolerance belongs here at the call site rather than in either script.
 */
const runSoft = (label, cmd, args) => {
  try {
    run(cmd, args);
  } catch {
    console.warn(`\n[package] ${label} failed — shipping the cached table as-is.\n`);
  }
};

// 1. Refresh the cached model prices so every release ships current rates. Neither table is ever
//    fetched at runtime, so packaging is the only point at which either can be updated.
//
//    (a) The extension's compiled table, bundled into dist/extension.js.
runSoft("extension price refresh", "node",
  [join(extDir, "..", "..", "packages", "tokenomics", "scripts", "update-prices.mjs")]);

//    (b) The pack CLI's own `prices.json`, read at runtime by the copy installed into a workspace.
//        Same upstream, so a fresh install does not start out on a stale snapshot.
runSoft("pack price refresh", "node",
  [join(extDir, "resources", "octobots-pack", "tokenomics", "update-prices.mjs")]);

// 2. Clean stale webview assets (vite does not empty media/ between builds) so the vsix only
//    contains the current bundle, then rebuild fresh.
rmSync(join(extDir, "media", "assets"), { recursive: true, force: true });
rmSync(join(extDir, "media", "index.html"), { force: true });
run("node", ["esbuild.mjs"]);
run("npx", ["--yes", "vite", "build"]);

// 3. Package with a temporary, vsce-valid manifest overlay.
const pkgPath = join(extDir, "package.json");
const original = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(original);
const out = join(extDir, `octobots-${pkg.version}.vsix`);

// vsce can't package a scoped `name` (@octoshell/…); rewrite it to the unscoped extension id.
// `name` (with `publisher`) forms the unique id `onetest-ai.octobots`; the human-facing label is
// `displayName` ("Octobots"). Everything else (publisher, displayName, description, icon, …) comes
// from package.json.
const overlay = {
  ...pkg,
  name: "octobots",
};

try {
  writeFileSync(pkgPath, JSON.stringify(overlay, null, 2) + "\n");
  run("npx", ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--out", out]);
} finally {
  writeFileSync(pkgPath, original);
}

console.log(`\nVSIX written: ${out}`);
console.log(`Install with: code --install-extension "${out}"`);
