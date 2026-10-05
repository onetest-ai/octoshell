#!/usr/bin/env node
// QA harness (campaign "Test conventions" rule 3, owned by M2/T2.3). NOT part of the shipped extension.
//
// Usage: node apps/vscode-extension/scripts/qa/install-pack.mjs <workspace> [--pack-root <dir>]
//
// Runs the extension's own pack installer against <workspace> without a VS Code runtime: it bundles
// src/host/octobots-skill.ts in memory with esbuild (that import graph is vscode-free) and calls
// packStatus, installPack, packStatus. --pack-root is the pack to install from (default
// resources/octobots-pack); M6-AC8 points it at the pack unzipped from the VSIX.
//
// Prints JSON: {before, result, after}
//   before / after  packStatus(<workspace>): {installed, currentVersion, upToDate}
//   result          installPack(<pack root>, <workspace>): {written, hooksRegistered, statusline, tools}
// Exits 1 (error on stderr) if the install throws, 2 on a usage error.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const args = process.argv.slice(2);
let packRootArg;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pack-root") packRootArg = args[++i];
  else positional.push(args[i]);
}
const [workspaceArg] = positional;
if (!workspaceArg || workspaceArg.startsWith("-") || positional.length > 1 || (args.includes("--pack-root") && !packRootArg)) {
  console.error("usage: install-pack.mjs <workspace> [--pack-root <dir>]");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..", "..");
const workspace = resolve(workspaceArg);
const packRoot = resolve(packRootArg ?? join(extRoot, "resources", "octobots-pack"));

try {
  if (!existsSync(workspace)) throw new Error(`workspace not found: ${workspace}`);
  const out = await build({
    entryPoints: [join(extRoot, "src", "host", "octobots-skill.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const before = mod.packStatus(workspace);
  const result = mod.installPack(packRoot, workspace);
  const after = mod.packStatus(workspace);
  console.log(JSON.stringify({ before, result, after }, null, 2));
} catch (e) {
  console.error(`install-pack: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
