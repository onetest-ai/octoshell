import { describe, expect, it } from "vitest";
import { parsePackVersionMarker } from "../src/host/pack-version-marker.js";
import { parsePrimerVersion } from "../src/host/octobots-skill.js";
import { parseTokenomicsVersion } from "../src/host/octobots-tokenomics.js";
import { parseGraphVersion } from "../src/host/octograph-install.js";

/**
 * Three pack payloads carry the same `// octobots-pack-version: N` marker, and three exported
 * readers exist for it. They used to be three independent copies of one regex; `parseGraphVersion`
 * was the third. One shared list of cases, run through all three readers, is what keeps them one
 * rule: if any reader is ever re-derived and disagrees, a payload is stale by one rule and current
 * by another, and a workspace is either never prompted to upgrade or prompted forever.
 */
const READERS = {
  parsePackVersionMarker,
  parsePrimerVersion,
  parseTokenomicsVersion,
  parseGraphVersion,
} as const;

const CASES: ReadonlyArray<readonly [string, string, number | null]> = [
  ["a primer-style comment line", "#!/usr/bin/env node\n// octobots-pack-version: 41\n", 41],
  ["an esbuild banner under a shebang", "#!/usr/bin/env node\n// octobots-pack-version: 7\n\ncode", 7],
  ["no marker at all", "just a file with no marker", null],
  ["extra spacing after the colon", "// octobots-pack-version:   12\n", 12],
  ["no spacing after the colon", "// octobots-pack-version:3\n", 3],
  ["a multi-digit version", "// octobots-pack-version: 1234\n", 1234],
  ["the FIRST marker wins over any later occurrence in bundled source text", "// octobots-pack-version: 41\n// octobots-pack-version: 9\n", 41],
  ["a marker mentioned but with no number", "// octobots-pack-version: soon\n", null],
];

describe("the octobots-pack-version marker is read by ONE rule", () => {
  for (const [name, reader] of Object.entries(READERS)) {
    for (const [label, text, expected] of CASES) {
      it(`${name}: ${label}`, () => {
        expect(reader(text)).toBe(expected);
      });
    }
  }
});
