#!/usr/bin/env node
// QA harness (campaign "Test conventions" rule 3, owned by M2/T2.3). NOT part of the shipped extension.
//
// Usage: node apps/vscode-extension/scripts/qa/install-pack.mjs <workspace> [--pack-root <dir>]
//          [--local-changes=reconcile|overwrite|keep] [--pack-version <n>]
//
// Runs the extension's own pack installer against <workspace> without a VS Code runtime: it bundles
// src/host/octobots-skill.ts in memory with esbuild (that import graph is vscode-free) and calls
// packStatus, installPack, packStatus.
//   --pack-root       the pack to install from (default resources/octobots-pack); M6-AC8 points it at
//                     the pack unzipped from the VSIX. It replaces the PACK only: detection and base
//                     recovery always read this extension's resources/shipped-skills.json.br.
//   --local-changes   what to do with a pack skill whose SKILL.md the workspace changed (default
//                     reconcile, as any non-interactive install records).
//   --pack-version    overrides the pack version for detection and staging (QA only, to exercise a
//                     later version).
//
// Prints JSON: {before, deviations, result, after}
//   before / after  packStatus(<workspace>)
//   deviations      the changed pack skills found before the install: [{skill, version, reason, retired, sha256}]
//   result          installPack(...): {written, hooksRegistered, statusline, tools, pending, kept, keptFiles}
// Writes `<n> skill(s) need reconcile` to stderr when n skills are staged. Exits 1 (error on stderr)
// if the install throws or refuses (store missing), 2 on a usage error.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const USAGE = "usage: install-pack.mjs <workspace> [--pack-root <dir>] [--local-changes=reconcile|overwrite|keep] [--pack-version <n>]";
const args = process.argv.slice(2);
let packRootArg;
let localChanges = "reconcile";
let packVersion;
const positional = [];
const usage = () => { console.error(USAGE); process.exit(2); };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--pack-root") { packRootArg = args[++i]; if (!packRootArg) usage(); }
  else if (a === "--pack-version") {
    const v = args[++i];
    if (!/^\d+$/.test(v ?? "")) usage();
    packVersion = Number(v);
  }
  else if (a.startsWith("--local-changes=")) {
    localChanges = a.slice("--local-changes=".length);
    if (!["reconcile", "overwrite", "keep"].includes(localChanges)) usage();
  }
  else if (a.startsWith("-")) usage();
  else positional.push(a);
}
const [workspaceArg] = positional;
if (!workspaceArg || positional.length > 1) usage();

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..", "..");
const workspace = resolve(workspaceArg);
const packRoot = resolve(packRootArg ?? join(extRoot, "resources", "octobots-pack"));

try {
  if (!existsSync(workspace)) throw new Error(`workspace not found: ${workspace}`);
  const out = await build({
    stdin: {
      contents: 'export * from "./octobots-skill.ts"; export { loadShippedStore, detectDeviations } from "./pack-deviations.ts";',
      resolveDir: join(extRoot, "src", "host"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const store = mod.loadShippedStore(join(extRoot, "resources", "shipped-skills.json.br"));
  const version = packVersion ?? mod.OCTOBOTS_PACK_VERSION;
  const before = mod.packStatus(workspace, version, store);
  const deviations = before.deviations;
  const result = mod.installPack(packRoot, workspace, { store, localChanges, ...(packVersion === undefined ? {} : { packVersion }) });
  const after = mod.packStatus(workspace, version, store);
  console.log(JSON.stringify({ before, deviations, result, after }, null, 2));
  if (result.error) throw new Error(result.error);
  if (result.pending.length > 0) console.error(`${result.pending.length} skill(s) need reconcile`);
} catch (e) {
  console.error(`install-pack: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
