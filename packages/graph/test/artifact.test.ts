import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { readArtifact, resolveOut, writeArtifact, type StoredGraph } from "../src/artifact.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

describe("resolveOut", () => {
  it("uses .octobots/graph when a board exists", () => {
    const root = mkdtempClean("art-");
    mkdirSync(join(root, ".octobots"));
    expect(resolveOut(root, DEFAULTS)).toBe(join(root, ".octobots", "graph"));
  });

  it("falls back to .octograph with no board and never creates .octobots", () => {
    const root = mkdtempClean("art-");
    expect(resolveOut(root, DEFAULTS)).toBe(join(root, ".octograph"));
    expect(() => readFileSync(join(root, ".octobots"))).toThrow();
  });

  it("honours an explicit out setting even when a board exists", () => {
    const root = mkdtempClean("art-");
    mkdirSync(join(root, ".octobots"));
    expect(resolveOut(root, { ...DEFAULTS, out: "custom" })).toBe(join(root, "custom"));
  });
});

describe("artifact round-trip", () => {
  it("returns null before anything is written, not an empty object", () => {
    const dir = mkdtempClean("art-");
    expect(readArtifact(dir)).toBeNull();
  });

  it("returns null for a directory that does not exist yet", () => {
    const dir = join(mkdtempClean("art-"), "graph");
    expect(readArtifact(dir)).toBeNull();
  });

  it("round-trips cluster membership read back off disk", () => {
    const dir = mkdtempClean("art-");
    writeArtifact(dir, { version: 1, clusters: { 3: ["a.ts"], 7: ["b.ts"] }, config: DEFAULTS });

    // Re-read through readArtifact rather than trusting the in-memory value
    // passed to writeArtifact — the spec calls this out explicitly: a fix
    // pinned over an in-memory value rather than the artifact on disk shipped
    // the same dangling-reference defect three times in M2.
    const reread = readArtifact(dir);
    expect(reread?.clusters[7]).toEqual(["b.ts"]);
    expect(reread?.clusters[3]).toEqual(["a.ts"]);

    // And independently, against the raw file content on disk.
    const raw = JSON.parse(readFileSync(join(dir, "clusters.json"), "utf8")) as StoredGraph;
    expect(raw.clusters[7]).toEqual(["b.ts"]);
  });

  it("writes byte-identical output for two writes of identical input", () => {
    const dir = mkdtempClean("art-");
    const graph: StoredGraph = { version: 1, clusters: { 2: ["b.ts", "a.ts"], 1: ["c.ts"] }, config: DEFAULTS };

    writeArtifact(dir, graph);
    const first = readFileSync(join(dir, "clusters.json"), "utf8");

    writeArtifact(dir, graph);
    const second = readFileSync(join(dir, "clusters.json"), "utf8");

    expect(second).toBe(first);
  });

  it("orders cluster keys numerically and members alphabetically regardless of input order", () => {
    const dir = mkdtempClean("art-");
    writeArtifact(dir, { version: 1, clusters: { 10: ["z.ts", "a.ts"], 2: ["y.ts"] }, config: DEFAULTS });

    const raw = readFileSync(join(dir, "clusters.json"), "utf8");
    expect(raw.indexOf('"2"')).toBeLessThan(raw.indexOf('"10"'));
    expect(raw.indexOf('"a.ts"')).toBeLessThan(raw.indexOf('"z.ts"'));
  });
});
