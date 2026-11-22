#!/usr/bin/env node
// Derives the pack doctor's default required-hooks list from the installer's own list
// (OCTOBOTS_HOOK_SPECS in src/host/octobots-hooks.ts), so the two cannot drift.
//
//   node apps/vscode-extension/scripts/required-hooks.mjs --write    regenerate the file
//   node apps/vscode-extension/scripts/required-hooks.mjs [--verify] exit 1 when the file is stale
//
// The file is resources/octobots-pack/hooks/required-hooks.json; installPrimer copies it next to
// hooks-doctor.mjs, which reads it as its default list.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(extRoot, "resources", "octobots-pack", "hooks", "required-hooks.json");
const out = await build({
  stdin: { contents: 'export { octoshellRequiredHooks } from "./octobots-hooks.ts";', resolveDir: join(extRoot, "src", "host"), loader: "ts" },
  bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent",
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const want = JSON.stringify(mod.octoshellRequiredHooks(), null, 2) + "\n";
if (process.argv.includes("--write")) {
  writeFileSync(target, want);
  console.log(`wrote ${target}`);
} else {
  let have = "";
  try { have = readFileSync(target, "utf8"); } catch { /* missing counts as stale */ }
  if (have !== want) {
    console.error(`required-hooks.json is stale: run node apps/vscode-extension/scripts/required-hooks.mjs --write`);
    process.exit(1);
  }
  console.log("required-hooks.json is current");
}
