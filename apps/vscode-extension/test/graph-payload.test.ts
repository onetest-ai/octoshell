import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const VERSIONS_LOCK = join(__dirname, "..", "scripts", "graph-payload-versions.json");

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

/**
 * REGRESSION (found in the M6 mission review, 2026-08-11): the freshness gate above keeps the
 * COMMITTED payload equal to what `packages/graph` produces now — but nothing kept the pack
 * VERSION honest about it, and that number is the only thing an installed workspace ever compares.
 *
 * `graphStatus` (`octograph-install.ts`) calls an installed payload `current` when its
 * `// octobots-pack-version: N` banner equals `OCTOBOTS_PACK_VERSION`. For the primer and the
 * tokenomics runner that marker is a hand-edited line inside the file being changed, so changing
 * one puts the bump under the author's cursor. The graph payload is not hand-edited: it is
 * MACHINE-GENERATED from another package's source and its banner is stamped from
 * `OCTOBOTS_PACK_VERSION`. So a change anywhere in `packages/graph` regenerates different bytes
 * under an unchanged banner, and then:
 *
 *   - the freshness gate is satisfied (the committed payload was regenerated),
 *   - `graphStatus` reports `{ present: true, current: true }` for the OLD installed bundle,
 *   - `packStatus().upToDate` stays true, so `activate()` never shows the upgrade prompt,
 *   - and every workspace that already ran "Octobots: Install Graph" keeps running the stale
 *     bundle indefinitely, with nothing anywhere saying so.
 *
 * Verified on this tree before the guard existed: editing a string literal in
 * `packages/graph/src/cli.ts` and rebuilding produced different payload bytes with the banner
 * still reading `// octobots-pack-version: 42`.
 *
 * `scripts/graph-payload-versions.json` closes it by recording the payload's hash AGAINST the
 * version it shipped under. Regenerate the payload without bumping and this goes red by name.
 */
describe("the pack version stays honest about the payload's content", () => {
  const lock = JSON.parse(readFileSync(VERSIONS_LOCK, "utf8")) as Record<string, string>;

  /** Recorded version → hash pairs, with the `_`-prefixed prose keys dropped. */
  function recorded(): [number, string][] {
    return Object.entries(lock)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [Number(k), v]);
  }

  it("the committed payload's sha256 is recorded against the CURRENT pack version", () => {
    const sha = createHash("sha256").update(readFileSync(PAYLOAD_PATH)).digest("hex");
    // Reported as an object so a failure prints both the expected and the actual hash together
    // with the version they were judged under, rather than two bare hex strings.
    expect({
      packVersion: OCTOBOTS_PACK_VERSION,
      sha,
      hint:
        "if this fails, packages/graph changed: bump OCTOBOTS_PACK_VERSION (and every pack marker " +
        "with it) and add the new sha to scripts/graph-payload-versions.json, or installed " +
        "workspaces will never be prompted to upgrade their octograph bundle",
    }).toEqual({
      packVersion: OCTOBOTS_PACK_VERSION,
      sha: lock[String(OCTOBOTS_PACK_VERSION)],
      hint: expect.any(String),
    });
  });

  it("meta: the lock is a non-empty map of integer versions, none ahead of the current one", () => {
    const entries = recorded();
    expect(entries.length).toBeGreaterThan(0);
    for (const [version, sha] of entries) {
      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeLessThanOrEqual(OCTOBOTS_PACK_VERSION);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("meta: the guard is not vacuous — a byte-different payload fails against the same version", () => {
    // The rule the test above enforces, applied to a payload that differs from the committed one
    // by a single byte. If this passed, the check would be comparing something other than content.
    const mutated = Buffer.from(readFileSync(PAYLOAD_PATH));
    mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0xff;
    const sha = createHash("sha256").update(mutated).digest("hex");
    expect(sha).not.toBe(lock[String(OCTOBOTS_PACK_VERSION)]);
  });
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
