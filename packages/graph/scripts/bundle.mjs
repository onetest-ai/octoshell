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

await build({
  entryPoints: ["bin/octograph.mjs"],
  outfile: "dist/octograph.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "info",
});
