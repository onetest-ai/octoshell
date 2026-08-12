import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphStatus, installGraph, parseGraphVersion, GRAPH_RELATIVE_PATH } from "../src/host/octograph-install.js";
import { installPack, packStatus, OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

describe("parseGraphVersion", () => {
  it("reads the octobots-pack-version marker, or null when absent", () => {
    expect(parseGraphVersion("// octobots-pack-version: 41\nrest of the bundle")).toBe(41);
    expect(parseGraphVersion("no marker here")).toBeNull();
  });
});

describe("graphStatus", () => {
  it("reports absent for a workspace with no installed graph payload", () => {
    const repo = mkdtempClean("octograph-install-");
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: false, current: false });
  });

  it("reports present + current when the installed marker matches the pack version", () => {
    const repo = mkdtempClean("octograph-install-");
    const dir = join(repo, ".claude", "skills", "graph");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "octograph.mjs"), `// octobots-pack-version: ${OCTOBOTS_PACK_VERSION}\nbody`);
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
  });

  it("reports present but stale when the installed marker is an older version", () => {
    const repo = mkdtempClean("octograph-install-");
    const dir = join(repo, ".claude", "skills", "graph");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "octograph.mjs"), "// octobots-pack-version: 1\nbody");
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: false });
  });

  it("does not throw on a read error and reports absent instead", () => {
    const repo = mkdtempClean("octograph-install-");
    // A directory where the file is expected — readFileSync throws EISDIR, not ENOENT.
    mkdirSync(join(repo, ".claude", "skills", "graph", "octograph.mjs"), { recursive: true });
    expect(() => graphStatus(repo, OCTOBOTS_PACK_VERSION)).not.toThrow();
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: false, current: false });
  });
});

describe("installGraph", () => {
  it("copies the payload byte-identical to the shipped resource", () => {
    const repo = mkdtempClean("octograph-install-");
    const written = installGraph(PACK_SRC, repo);
    expect(written).toBe(1);

    const target = join(repo, GRAPH_RELATIVE_PATH);
    expect(existsSync(target)).toBe(true);
    const shipped = readFileSync(join(PACK_SRC, "graph", "octograph.mjs"));
    expect(readFileSync(target)).toEqual(shipped);
  });

  it("reports present+current via graphStatus immediately after install", () => {
    const repo = mkdtempClean("octograph-install-");
    installGraph(PACK_SRC, repo);
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
  });

  it("a failed install leaves the previously installed payload intact, and no temp file behind", () => {
    // REGRESSION: this used a plain `copyFileSync` onto the live path. `copyFileSync` opens the
    // destination with O_TRUNC before reading a byte of the source, so a copy that fails part-way
    // destroys what was already installed — verified 2026-08-11 on macOS, where the failing copy
    // DELETED the destination outright. A truncated survivor is worse still: it keeps the version
    // banner on line 2, so `graphStatus` reports it `current` while `node` on it dies mid-file.
    //
    // A source directory where a file is expected is the cheapest reproducible mid-copy failure:
    // the open succeeds, the read does not.
    const repo = mkdtempClean("octograph-install-");
    installGraph(PACK_SRC, repo);
    const target = join(repo, GRAPH_RELATIVE_PATH);
    const good = readFileSync(target);

    const brokenSrc = mkdtempClean("octograph-broken-src-");
    mkdirSync(join(brokenSrc, "graph", "octograph.mjs"), { recursive: true });

    expect(() => installGraph(brokenSrc, repo)).toThrow();

    expect(readFileSync(target)).toEqual(good);
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
    expect(readdirSync(join(repo, ".claude", "skills", "graph"))).toEqual(["octograph.mjs"]);
  });

  it("returns 0 and writes nothing when the pack ships no graph payload", () => {
    const repo = mkdtempClean("octograph-install-");
    const emptySrc = mkdtempClean("octograph-empty-src-");
    const written = installGraph(emptySrc, repo);
    expect(written).toBe(0);
    expect(existsSync(join(repo, ".claude", "skills", "graph"))).toBe(false);
  });
});

describe("graph wiring into packStatus / installPack — one drift mechanism, not two", () => {
  it("a workspace that never installed graph stays reported installed/up-to-date on graph alone", () => {
    const repo = mkdtempClean("octograph-install-");
    installPack(PACK_SRC, repo);
    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION).present).toBe(false);
    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(true);
  });

  it("a stale installed graph payload flips packStatus.upToDate, the same signal a stale skill gives", () => {
    const repo = mkdtempClean("octograph-install-");
    installPack(PACK_SRC, repo);
    const entry = join(repo, GRAPH_RELATIVE_PATH);
    mkdirSync(join(repo, ".claude", "skills", "graph"), { recursive: true });
    writeFileSync(entry, "// octobots-pack-version: 1\nstale body");

    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(false);
  });

  it("re-running installPack refreshes an already-present graph payload to current", () => {
    const repo = mkdtempClean("octograph-install-");
    installPack(PACK_SRC, repo);
    const entry = join(repo, GRAPH_RELATIVE_PATH);
    mkdirSync(join(repo, ".claude", "skills", "graph"), { recursive: true });
    writeFileSync(entry, "// octobots-pack-version: 1\nstale body");

    installPack(PACK_SRC, repo);

    expect(graphStatus(repo, OCTOBOTS_PACK_VERSION)).toEqual({ present: true, current: true });
  });

  it("installPack does not install graph for a workspace that never asked for it", () => {
    const repo = mkdtempClean("octograph-install-");
    installPack(PACK_SRC, repo);
    expect(existsSync(join(repo, ".claude", "skills", "graph"))).toBe(false);
  });
});
