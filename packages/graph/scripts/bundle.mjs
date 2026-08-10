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
// `bundle: true` with no `external` inlines every dependency (js-yaml
// included) rather than leaving a `require`/`import` for something that
// will not exist at the run site.
import { build } from "esbuild";

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
const outfile = process.argv[2] ?? "dist/octograph.mjs";

await build({
  entryPoints: ["bin/octograph.mjs"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "info",
});
