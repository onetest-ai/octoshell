import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), "cfg-")))).toEqual(DEFAULTS);
  });

  it("merges octograph.yaml over the defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "halfLifeDays: 90\n");
    const cfg = loadConfig(root);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.minSupport).toBe(DEFAULTS.minSupport);
  });

  it("lets explicit overrides beat the file", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "halfLifeDays: 90\n");
    expect(loadConfig(root, { halfLifeDays: 30 }).halfLifeDays).toBe(30);
  });

  it("ignores a malformed config rather than crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "{oops");
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on invalid YAML syntax, never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "halfLifeDays: [unterminated\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on an empty file, never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on a bare scalar top level, never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "42\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on a bare string scalar top level, never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "hello\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on a bare sequence top level, never throws", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "- a\n- b\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("ignores wrong-typed values (string and boolean) but still applies a valid sibling key in the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(
      join(root, "octograph.yaml"),
      ["halfLifeDays: \"180\"", "budgetTokens: true", "minSupport: 5"].join("\n") + "\n",
    );
    const cfg = loadConfig(root);
    // Both bad keys fall back to their own defaults...
    expect(cfg.halfLifeDays).toBe(DEFAULTS.halfLifeDays);
    expect(cfg.budgetTokens).toBe(DEFAULTS.budgetTokens);
    // ...while the valid sibling key in the same file still applies.
    expect(cfg.minSupport).toBe(5);
  });

  /**
   * `Partial<Config>` is exactly the shape a caller assembling CLI flags
   * builds, and `{ budgetTokens: argv.budget }` is `{ budgetTokens: undefined }`
   * when the flag is absent — not `{}`. A spread copies that explicit
   * `undefined` over a perfectly good default, and `estimateTokens(md) >
   * undefined` is false for every map, so the token budget silently stops
   * applying to the committed artifact.
   */
  it("treats an explicitly-undefined override as absent, not as a value", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "budgetTokens: 900\n");
    const cfg = loadConfig(root, { budgetTokens: undefined, minSupport: 7 });
    // The file's value survives an absent flag...
    expect(cfg.budgetTokens).toBe(900);
    // ...and a real override in the same object still applies.
    expect(cfg.minSupport).toBe(7);
    // With no file either, the default survives.
    const bare = mkdtempSync(join(tmpdir(), "cfg-"));
    expect(loadConfig(bare, { halfLifeDays: undefined }).halfLifeDays).toBe(
      DEFAULTS.halfLifeDays,
    );
  });

  /**
   * The regression this test exists for (M3 bug: `Config.out` had no
   * containment check).
   *
   * `out` is read from repo content (octograph.yaml) with no validation
   * before this fix, so `out: '../../..'` was accepted verbatim. M2 never
   * consumes `Config.out`, but a future writer would — and an escaping path
   * must degrade to the default, the same per-key fallback every other
   * config key already gets on bad input, not throw and not write outside
   * the repo.
   */
  it("falls back to the default out path when octograph.yaml's out escapes the repo root", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "out: '../../..'\n");
    expect(loadConfig(root).out).toBe(DEFAULTS.out);
  });

  it("accepts a legitimate in-repo out path from octograph.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.yaml"), "out: graphify-out\n");
    expect(loadConfig(root).out).toBe("graphify-out");
  });

  it("reads values correctly with comments present", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(
      join(root, "octograph.yaml"),
      [
        "# tuning notes",
        "halfLifeDays: 90 # half a year is too long for this repo",
        "minSupport: 4",
      ].join("\n") + "\n",
    );
    const cfg = loadConfig(root);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.minSupport).toBe(4);
  });
});
