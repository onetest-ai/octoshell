import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFreshPayload, readPackVersionFromSource, PAYLOAD_PATH } from "../scripts/graph-payload.mjs";
import { OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { parseGraphVersion } from "../src/host/octograph-install.js";

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
});
