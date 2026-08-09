import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), "cfg-")))).toEqual(DEFAULTS);
  });

  it("merges octograph.json over the defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.json"), JSON.stringify({ halfLifeDays: 90 }));
    const cfg = loadConfig(root);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.minSupport).toBe(DEFAULTS.minSupport);
  });

  it("lets explicit overrides beat the file", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.json"), JSON.stringify({ halfLifeDays: 90 }));
    expect(loadConfig(root, { halfLifeDays: 30 }).halfLifeDays).toBe(30);
  });

  it("ignores a malformed config rather than crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.json"), "{oops");
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });
});
