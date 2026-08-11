import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFreshPayload,
  isDirectRun,
  readPackVersionFromSource,
  PAYLOAD_PATH,
} from "../scripts/graph-payload.mjs";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { parseGraphVersion } from "../src/host/octograph-install.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const GRAPH_PKG_ROOT = join(__dirname, "..", "..", "..", "packages", "graph");

describe("scripts/graph-payload.mjs", () => {
  it("readPackVersionFromSource stays equal to the real, imported OCTOBOTS_PACK_VERSION", () => {
    // This IS a duplicated spelling of one number (the build script cannot `import` TypeScript —
    // see the doc comment on readPackVersionFromSource) — this test is what keeps the two from
    // drifting unnoticed.
    expect(readPackVersionFromSource()).toBe(OCTOBOTS_PACK_VERSION);
  });

  it("the esbuild banner survives bundling: the built bundle's marker equals the current pack version", async () => {
    const fresh = await buildFreshPayload();
    const text = Buffer.from(fresh).toString("utf8");
    expect(parseGraphVersion(text)).toBe(OCTOBOTS_PACK_VERSION);
  });

  it("the committed payload is byte-identical to what building fresh produces right now", async () => {
    const fresh = await buildFreshPayload();
    const committed = readFileSync(PAYLOAD_PATH);
    expect(Buffer.compare(committed, Buffer.from(fresh))).toBe(0);
  }, 30_000);

  it("the shebang stays the first line so the payload still runs as a direct executable", async () => {
    const fresh = await buildFreshPayload();
    const firstLine = Buffer.from(fresh).toString("utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it(
    "the payload is packages/graph's OWN bundle.mjs output plus the banner — one esbuild config, not two",
    () => {
      // The freshness gate compares the committed payload against `buildFreshPayload()`. If that
      // built with its own restated esbuild options, the two could drift from
      // `packages/graph/scripts/bundle.mjs` — the artifact five e2e gates in that package copy out
      // and run — and every check here would stay green while users ran different bytes. So this
      // test runs THAT script and pins its output against the committed payload directly: the only
      // permitted difference is the `// octobots-pack-version: N` banner line.
      const out = join(mkdtempClean("octograph-bundle-pin-"), "octograph.mjs");
      execFileSync("node", ["scripts/bundle.mjs", out], { cwd: GRAPH_PKG_ROOT, stdio: "pipe" });

      const bundled = readFileSync(out, "utf8");
      const nl = bundled.indexOf("\n");
      const withBanner =
        bundled.slice(0, nl + 1) +
        `// octobots-pack-version: ${OCTOBOTS_PACK_VERSION}\n` +
        bundled.slice(nl + 1);

      expect(readFileSync(PAYLOAD_PATH, "utf8")).toBe(withBanner);
    },
    60_000,
  );
});

describe("isDirectRun — the guard deciding whether the freshness check runs at all", () => {
  // REGRESSION: this was spelled `import.meta.url === \`file://${process.argv[1]}\``. `import.meta.url`
  // is percent-encoded, `process.argv[1]` is a raw path, so any checkout under a directory with a
  // space (or `#`, or a non-ASCII character, or any path on Windows) made them differ — `main()`
  // never ran, `node scripts/graph-payload.mjs --verify` exited 0 printing nothing, and `pnpm
  // build`'s payload gate silently enforced nothing. Verified by running the script from a
  // directory named "tmp probe dir": exit 0, no output, no verification.
  const cases = [
    ["a plain path", "/repo/apps/vscode-extension/scripts/graph-payload.mjs"],
    ["a path with a space", "/Users/me/my projects/octoshell/scripts/graph-payload.mjs"],
    ["a path with a hash", "/repo/c#/scripts/graph-payload.mjs"],
    ["a non-ASCII path", "/repo/工作/scripts/graph-payload.mjs"],
  ] as const;

  for (const [label, argv1] of cases) {
    it(`is true when this module IS the entry point — ${label}`, () => {
      expect(isDirectRun(pathToFileURL(argv1).href, argv1)).toBe(true);
    });
  }

  it("is false when some other module is the entry point (imported by a test)", () => {
    expect(
      isDirectRun(pathToFileURL("/repo/scripts/graph-payload.mjs").href, "/repo/test/runner.mjs"),
    ).toBe(false);
  });

  it("is false, not a throw, when there is no argv[1] at all (`node -e`)", () => {
    expect(isDirectRun("file:///repo/scripts/graph-payload.mjs", undefined)).toBe(false);
  });
});
