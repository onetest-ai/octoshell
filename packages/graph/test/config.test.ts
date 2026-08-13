import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    expect(loadConfig(mkdtempClean("cfg-"))).toEqual(DEFAULTS);
  });

  it("merges octograph.yaml over the defaults", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "halfLifeDays: 90\n");
    const cfg = loadConfig(root);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.minSupport).toBe(DEFAULTS.minSupport);
  });

  it("reads T4.3's lexical thresholds from octograph.yaml, same as any other numeric key", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "lexicalConfidenceFloor: 0.4\nlexicalRunnerUpMargin: 0.1\n");
    const cfg = loadConfig(root);
    expect(cfg.lexicalConfidenceFloor).toBe(0.4);
    expect(cfg.lexicalRunnerUpMargin).toBe(0.1);
    // Untouched sibling still falls back to its own default.
    expect(cfg.minSupport).toBe(DEFAULTS.minSupport);
  });

  it("lets explicit overrides beat the file", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "halfLifeDays: 90\n");
    expect(loadConfig(root, { halfLifeDays: 30 }).halfLifeDays).toBe(30);
  });

  it("ignores a malformed config rather than crashing", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "{oops");
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on invalid YAML syntax, never throws", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "halfLifeDays: [unterminated\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on an empty file, never throws", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on a bare scalar top level, never throws", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "42\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on a bare string scalar top level, never throws", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "hello\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("degrades to defaults on a bare sequence top level, never throws", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "- a\n- b\n");
    expect(() => loadConfig(root)).not.toThrow();
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });

  it("ignores wrong-typed values (string and boolean) but still applies a valid sibling key in the same file", () => {
    const root = mkdtempClean("cfg-");
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
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "budgetTokens: 900\n");
    const cfg = loadConfig(root, { budgetTokens: undefined, minSupport: 7 });
    // The file's value survives an absent flag...
    expect(cfg.budgetTokens).toBe(900);
    // ...and a real override in the same object still applies.
    expect(cfg.minSupport).toBe(7);
    // With no file either, the default survives.
    const bare = mkdtempClean("cfg-");
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
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "out: '../../..'\n");
    expect(loadConfig(root).out).toBe(DEFAULTS.out);
  });

  it("accepts a legitimate in-repo out path from octograph.yaml", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "out: graphify-out\n");
    expect(loadConfig(root).out).toBe("graphify-out");
  });

  /**
   * `vaultPath` carries the identical risk `out` does above, and is
   * validated through the same `insideRepo` helper for the same reason: it
   * is repo content (octograph.yaml), and `readVault` joins it onto
   * `repoRoot` unchecked, so an escaping value must degrade to the default
   * rather than pointing the vault reader outside the repo.
   */
  it("falls back to the default vault path when octograph.yaml's vaultPath escapes the repo root", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "vaultPath: '../../..'\n");
    expect(loadConfig(root).vaultPath).toBe(DEFAULTS.vaultPath);
  });

  it("accepts a legitimate in-repo vaultPath from octograph.yaml", () => {
    const root = mkdtempClean("cfg-");
    writeFileSync(join(root, "octograph.yaml"), "vaultPath: notes/vault\n");
    expect(loadConfig(root).vaultPath).toBe("notes/vault");
  });

  it("reads values correctly with comments present", () => {
    const root = mkdtempClean("cfg-");
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

  describe("excludePaths", () => {
    it("defaults to a list nobody has to assemble by hand", () => {
      // Asserted by PROPERTY, not by pinning the exact array. The list exists
      // so onboarding does not cost half an hour of enumerating directories,
      // so it will grow as ecosystems are added — and a test that pins every
      // element turns each addition into a mechanical edit that teaches
      // nothing. What must hold is that the categories are covered.
      const paths = loadConfig(mkdtempClean("cfg-")).excludePaths;
      for (const required of [
        ".agents/", ".claude/", ".octobots/",   // this tool's own state
        ".github/",                              // CI configuration
        "node_modules/", "vendor/",              // committed dependencies
        ".venv/", "__pycache__/",                // python environments
        "target/", "dist/",                      // build output kept in tree
      ]) {
        expect(paths, `${required} should be excluded by default`).toContain(required);
      }
      // Every entry is a directory prefix; `isExcludedPath` matches on
      // segment boundaries, so a bare name would silently match a FILE too.
      for (const p of paths) expect(p.endsWith("/"), `${p} should end with /`).toBe(true);
    });

    it("reads a list value from octograph.yaml, the same as any other key", () => {
      const root = mkdtempClean("cfg-");
      writeFileSync(
        join(root, "octograph.yaml"),
        "excludePaths:\n  - vendor/\n  - generated/\n",
      );
      expect(loadConfig(root).excludePaths).toEqual(["vendor/", "generated/"]);
    });

    it("lets an explicit empty list mean 'exclude nothing', not 'use the default'", () => {
      const root = mkdtempClean("cfg-");
      writeFileSync(join(root, "octograph.yaml"), "excludePaths: []\n");
      expect(loadConfig(root).excludePaths).toEqual([]);
    });

    /**
     * Same "wrong type degrades to the default" discipline every NUMERIC key
     * gets, extended to a list: a scalar instead of a list, or a list with a
     * non-string element, is rejected WHOLESALE rather than partially applied
     * or crashing the run.
     */
    it("falls back to the default on a wrong-shaped value, but still applies a valid sibling key", () => {
      const root = mkdtempClean("cfg-");
      writeFileSync(join(root, "octograph.yaml"), "excludePaths: not-a-list\nminSupport: 5\n");
      const cfg = loadConfig(root);
      expect(cfg.excludePaths).toEqual(DEFAULTS.excludePaths);
      expect(cfg.minSupport).toBe(5);
    });

    it("falls back to the default when the list contains a non-string element", () => {
      const root = mkdtempClean("cfg-");
      writeFileSync(join(root, "octograph.yaml"), "excludePaths:\n  - vendor/\n  - 7\n");
      expect(loadConfig(root).excludePaths).toEqual(DEFAULTS.excludePaths);
    });

    it("lets an explicit override beat both the file and the default", () => {
      const root = mkdtempClean("cfg-");
      writeFileSync(join(root, "octograph.yaml"), "excludePaths:\n  - vendor/\n");
      expect(loadConfig(root, { excludePaths: ["dist/"] }).excludePaths).toEqual(["dist/"]);
    });
  });
});
