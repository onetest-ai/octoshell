// The ONE spelling of octograph's esbuild bundle configuration.
//
// Two callers build this bundle, from two different packages and two different working
// directories:
//   - `scripts/bundle.mjs` (this package) → `dist/octograph.mjs`, the artifact five e2e gates in
//     `test/` copy out and run under bare `node`.
//   - `apps/vscode-extension/scripts/graph-payload.mjs` → the pack payload the extension ships and
//     installs into a workspace, which is the same bundle plus an `// octobots-pack-version: N`
//     banner.
//
// Spelled twice, those two drift silently: every gate in this package would keep testing
// `dist/octograph.mjs` while users ran a payload built with different options. So the options live
// here, exported, and both callers pass only their own deltas (`outfile`/`write`, `logLevel`,
// `banner`). `apps/vscode-extension/test/graph-payload.test.ts` additionally pins the two OUTPUTS
// byte-for-byte, so the sharing cannot be quietly unpicked either.
//
// `absWorkingDir` is load-bearing, not tidiness: esbuild writes each module's path into the bundle
// as a comment RELATIVE TO THE WORKING DIRECTORY, so without it the emitted bytes depend on where
// you happened to run the build from. `node apps/vscode-extension/scripts/graph-payload.mjs
// --verify` from the repo root then reports a perfectly fresh payload STALE and tells you to
// `--write` — which commits cwd-dependent bytes that fail CI. Pinning the working directory to
// this package makes the bytes a function of the source alone.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `packages/graph` (this file lives in `<pkg>/scripts/`). */
export const GRAPH_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * esbuild options producing the self-contained octograph CLI.
 *
 * `bundle: true` with no `external` inlines every dependency (js-yaml included) rather than
 * leaving a `require`/`import` for something that will not exist at the run site — see
 * `bundle.mjs`'s doc comment and `test/bundle.test.ts`, which runs the output from a directory
 * with no `node_modules` anywhere up the chain.
 *
 * @param {import("esbuild").BuildOptions} overrides caller-specific deltas (output destination,
 *   log level, banner). Anything that shapes the CODE belongs here, not in an override.
 */
export function octographBundleOptions(overrides = {}) {
  return {
    absWorkingDir: GRAPH_PKG_ROOT,
    entryPoints: ["bin/octograph.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    ...overrides,
  };
}
