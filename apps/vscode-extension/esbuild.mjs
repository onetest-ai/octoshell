// Bundle the extension host into a single CommonJS file so ESM-only @octoshell/*
// packages are inlined (no runtime require() of ESM). Externalize only the
// host-provided `vscode` module.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching dist/extension.js…");
} else {
  await build(options);
  console.log("Bundled dist/extension.js");
}
