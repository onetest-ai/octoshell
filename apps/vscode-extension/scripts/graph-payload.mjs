#!/usr/bin/env node
// Builds and verifies `resources/octobots-pack/graph/octograph.mjs` — the octograph CLI, bundled
// as pack payload the extension ships and a CLI agent in any workspace runs identical bytes of.
//
// Why this lives HERE and not in packages/graph:
// - packages/graph's own `scripts/bundle.mjs` writes `dist/octograph.mjs`, inside that package,
//   which this extension never reads (that gap is the reason this file exists at all — see
//   `docs/superpowers/plans/2026-08-11-octograph-extension-bridge.md` § "The gap this mission has
//   to close first").
// - `bundle` is not a turbo task, and the only workflow that runs `scripts/package-vsix.mjs` is
//   `.github/workflows/package-vsix.yml`, which is `workflow_dispatch` only — a freshness check
//   placed there would let a stale payload pass every PR. This module is wired into THIS
//   package's own `build` script instead (`package.json`), so `--verify` runs in the CI-gated
//   path `pnpm build` executes on every push.
// - Design decision (stated in the PR, not slipped in): an explicit shell-out from this build
//   script, not a `bundle` turbo task + a `@octoshell/graph` devDependency edge. Either satisfies
//   criterion 4 (no RUNTIME dependency — a devDependency is not one), but a shell-out needs no new
//   `package.json` entry at all, and `bundle.mjs`'s own test proves esbuild bundles straight from
//   `packages/graph`'s TypeScript source with no prior `tsc` build required, so there is no real
//   ordering problem for turbo to solve here.
//
// The bundle is COMMITTED (Task 1's decision, not deferred): a generated payload absent from a
// fresh clone would make this extension's build depend on build order a contributor can't see,
// and "stale" then has a concrete meaning this script can check — the committed bytes differ from
// what building fresh produces right now.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(HERE, "..");
const GRAPH_ENTRY_SRC = join(EXT_ROOT, "..", "..", "packages", "graph", "bin", "octograph.mjs");
const SKILL_SRC = join(EXT_ROOT, "src", "host", "octobots-skill.ts");

export const PAYLOAD_PATH = join(EXT_ROOT, "resources", "octobots-pack", "graph", "octograph.mjs");

/**
 * Reads `OCTOBOTS_PACK_VERSION` out of `octobots-skill.ts` by regex, WITHOUT executing or
 * transpiling TypeScript: this script runs under bare `node`, as part of `pnpm build`, before the
 * extension's own TypeScript is ever compiled, so it cannot `import` that module. The same
 * technique `packages/board/src/workflow-meta.ts` uses to read a workflow script's
 * `export const meta` without running the script (brace-match the literal, evaluate only that) —
 * see its doc comment for the precedent this follows.
 *
 * This IS a second spelling of one number, made visible and pinned rather than silent:
 * `test/graph-payload.test.ts` asserts this stays equal to the real, imported
 * `OCTOBOTS_PACK_VERSION` constant, so the two can never drift unnoticed.
 */
export function readPackVersionFromSource(text = readFileSync(SKILL_SRC, "utf8")) {
  const m = text.match(/OCTOBOTS_PACK_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error(`could not find OCTOBOTS_PACK_VERSION in ${SKILL_SRC}`);
  return Number(m[1]);
}

/**
 * Builds octograph.mjs fresh from packages/graph's current source, in memory (`write: false` — no
 * temp file, nothing to clean up). Mirrors `packages/graph/scripts/bundle.mjs`'s esbuild config
 * (entry point, `bundle: true`, platform/format/target) but adds the
 * `// octobots-pack-version: N` banner that script does not emit: this bundle IS pack payload,
 * `packages/graph`'s own `dist/octograph.mjs` is not, and `graphStatus` (`octograph-install.ts`)
 * depends on the marker being explicit rather than relying on esbuild's default comment retention.
 *
 * Returns the built bytes as a `Uint8Array`.
 */
export async function buildFreshPayload(version = readPackVersionFromSource()) {
  const result = await build({
    entryPoints: [GRAPH_ENTRY_SRC],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
    banner: { js: `// octobots-pack-version: ${version}` },
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no output for the octograph payload");
  return file.contents;
}

async function main() {
  const mode = process.argv[2] ?? "--verify";
  if (mode !== "--verify" && mode !== "--write") {
    process.stderr.write(`octograph payload: unknown mode "${mode}"; expected --verify or --write\n`);
    process.exit(2);
    return;
  }

  const fresh = await buildFreshPayload();

  if (mode === "--write") {
    mkdirSync(dirname(PAYLOAD_PATH), { recursive: true });
    writeFileSync(PAYLOAD_PATH, fresh);
    process.stdout.write(`octograph payload written: ${PAYLOAD_PATH} (${fresh.length} bytes)\n`);
    return;
  }

  if (!existsSync(PAYLOAD_PATH)) {
    process.stderr.write(
      `octograph payload missing at ${PAYLOAD_PATH}\n` +
        `Run: node scripts/graph-payload.mjs --write, then commit the result.\n`,
    );
    process.exit(1);
    return;
  }
  const committed = readFileSync(PAYLOAD_PATH);
  if (Buffer.compare(committed, Buffer.from(fresh)) !== 0) {
    process.stderr.write(
      `octograph payload is STALE: ${PAYLOAD_PATH} does not match what packages/graph's current ` +
        `source produces.\nRun: node scripts/graph-payload.mjs --write, then commit the result.\n`,
    );
    process.exit(1);
    return;
  }
  process.stdout.write("octograph payload is current.\n");
}

// Only run as a CLI when invoked directly (`node scripts/graph-payload.mjs`), not when imported
// by `test/graph-payload.test.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
