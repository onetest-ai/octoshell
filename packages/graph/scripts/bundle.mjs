// Bundles `bin/octograph.mjs` (and everything it pulls in from `src/`,
// including `js-yaml`) into ONE self-contained ESM file the pack ships and
// the extension's terminal commands invoke with bare `node` — no install
// step, no `node_modules` at the run site.
//
// This is the ONLY thing that produces that file. Hand-writing a second copy
// of the CLI logic as plain JS — the way `tokenomics` keeps an 838-line
// `octobots-pack/tokenomics/rollup.mjs` beside a 309-line `rollup.ts` that
// share no code — is exactly the drift trap this script exists to avoid: one
// source (`src/cli.ts`), one bundle, no hand-maintained second copy.
//
// The esbuild options themselves live in `bundle-options.mjs`, because a
// SECOND caller builds this same bundle: the VS Code extension's
// `scripts/graph-payload.mjs`, which ships it as pack payload. Spelled twice,
// the two configs drift and this package's five e2e gates keep testing
// `dist/octograph.mjs` while users run different bytes. `bundle: true` with no
// `external`, and everything else that shapes the code, is stated there once.
import { build } from "esbuild";
import { octographBundleOptions } from "./bundle-options.mjs";

// Optional argv[2]: where to write the bundle. `dist/octograph.mjs` is the
// shipped location and stays the default, so `pnpm --filter @octoshell/graph
// bundle` is unchanged.
//
// A caller passes its own path when it needs bytes nobody else is writing.
// Vitest runs test FILES in parallel, and two of them build this bundle
// (`bundle.test.ts`, which checks the shipped default output, and
// `e2e-gate.test.ts`, which runs it against this repo): pointed at one path,
// they interleave an esbuild write with the other's read of the same file —
// a torn or half-written .mjs, on whichever machine happens to schedule them
// together. That is a failure nobody can reproduce locally and everybody sees
// on CI, the same shape as the fixture-repo leak `mkdtempClean` closed.
// A relative path resolves against THIS PACKAGE (`absWorkingDir`), not the
// caller's cwd, so `dist/octograph.mjs` means the same file wherever the
// script is invoked from. Every in-repo caller passes an absolute path or runs
// with `cwd: packages/graph`, so this changes nothing for them.
const outfile = process.argv[2] ?? "dist/octograph.mjs";

await build(octographBundleOptions({ outfile, logLevel: "info" }));
