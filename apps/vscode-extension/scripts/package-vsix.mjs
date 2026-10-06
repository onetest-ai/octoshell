// Package the extension into an installable .vsix (NOT publishing).
//
// Self-contained: cleans stale webview output, rebuilds (esbuild host bundle + vite webview),
// then packages. The monorepo manifest uses a scoped name (@octoshell/vscode-extension) and has
// no `publisher`, both of which `vsce` rejects; esbuild already bundles every @octoshell/* dep
// into dist/extension.js (only `vscode` is external), so we package with --no-dependencies and
// ship no node_modules. The packaging-valid manifest is overlaid only around the vsce call and
// restored in a finally, so an error never leaves package.json patched.
//
// Packaging leaves tracked files unchanged: the price refresh is opt-in (--refresh-prices or
// OCTOSHELL_PACKAGE_REFRESH_PRICES=1) and its result is committed separately before the release
// commit. The shipped-skill store and graph payload are verified before anything is built.
//
// Usage: pnpm --filter @octoshell/vscode-extension package [--refresh-prices]
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { packageSteps, wantsPriceRefresh } from "./package-steps.mjs";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: extDir, stdio: "inherit" });

const refreshPrices = wantsPriceRefresh(process.argv.slice(2), process.env);

// Steps 1-2 (see package-steps.mjs): optional price refresh, store/payload verification, clean
// webview output, esbuild host bundle, vite webview build.
for (const step of packageSteps({ extDir, refreshPrices })) {
  if (step.rm) {
    for (const p of step.rm) rmSync(p, { recursive: true, force: true });
    continue;
  }
  try {
    run(step.cmd, step.args);
  } catch (err) {
    if (!step.soft) throw err;
    console.warn(`\n[package] ${step.label} failed — shipping the cached table as-is.\n`);
  }
}

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
