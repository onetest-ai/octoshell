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

// 1. Refresh the cached model prices so every release ships current rates. The
//    table is compiled into the bundle (never fetched at runtime), so this is
//    the only point at which it can be updated. Non-fatal by design: a network
//    failure leaves the cached table in place rather than breaking packaging.
run("node", [join(extDir, "..", "..", "packages", "tokenomics", "scripts", "update-prices.mjs")]);

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
