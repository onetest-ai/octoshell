import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig, type Config } from "../src/config.js";
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
    // Asserted with existsSync, NOT with `expect(() => readFileSync(...)).toThrow()`:
    // readFileSync throws EISDIR on a directory just as it throws ENOENT on a
    // missing one, so the throw-based form passes whether or not `.octobots`
    // was created and cannot fail on the thing this criterion is about.
    expect(existsSync(join(root, ".octobots"))).toBe(false);
  });

  it("honours an explicit out setting even when a board exists", () => {
    const root = mkdtempClean("art-");
    mkdirSync(join(root, ".octobots"));
    expect(resolveOut(root, { ...DEFAULTS, out: "custom" })).toBe(join(root, "custom"));
  });

  it("returns an ABSOLUTE in-repo out unchanged rather than nesting it under the root", () => {
    // `join(root, "/abs/in/repo")` concatenates: it yields
    // `<root>/abs/in/repo`, a tree mirroring the whole absolute path inside
    // the repo. The containment gate passes (the path really is inside), so
    // the write lands somewhere the caller never named and every "wrote …"
    // line then reports that invented location. Only `resolve` distinguishes
    // an already-absolute out from a relative one — and every other case in
    // this describe passes a relative value, where the two agree.
    const root = mkdtempClean("art-");
    const absolute = join(root, "build", "graph");
    expect(resolveOut(root, { ...DEFAULTS, out: absolute })).toBe(absolute);
  });

  it("rejects an out that escapes the repo root and falls back to the default", () => {
    const root = mkdtempClean("art-");
    const escaped = resolveOut(root, { ...DEFAULTS, out: "../../../tmp/octograph-escape" });
    expect(escaped).toBe(join(root, ".octograph"));
  });

  it("rejects an ABSOLUTE out outside the repo root too", () => {
    const root = mkdtempClean("art-");
    const other = mkdtempClean("art-elsewhere-");
    expect(resolveOut(root, { ...DEFAULTS, out: other })).toBe(join(root, ".octograph"));
  });

  /**
   * Proof the guard above is not dead code. `loadConfig` containment-checks
   * `out` only on the octograph.yaml path; its override loop — which is what
   * the documented `--out` CLI flag feeds — assigns the raw value straight
   * through. So an escaping `out` really does reach `resolveOut`.
   *
   * If this assertion ever fails because `loadConfig` started filtering
   * overrides too, that is good news, not a regression — but the next reader
   * should learn from a failing test that the check in `resolveOut` became
   * defence in depth rather than the only thing standing between `--out
   * ../../..` and a write outside the repo.
   */
  it("is reachable: loadConfig passes an escaping override out straight through", () => {
    const root = mkdtempClean("art-");
    expect(loadConfig(root, { out: "../../../tmp/octograph-escape" }).out).toBe(
      "../../../tmp/octograph-escape",
    );
  });
});

describe("resolveOut + writeArtifact land the file where the criterion says", () => {
  it("writes under .octobots/graph when a board exists", () => {
    const root = mkdtempClean("art-");
    mkdirSync(join(root, ".octobots"));
    writeArtifact(resolveOut(root, DEFAULTS), {
      version: 1,
      clusters: { 0: ["a.ts"] },
      config: DEFAULTS,
    });
    expect(existsSync(join(root, ".octobots", "graph", "clusters.json"))).toBe(true);
  });

  it("writes under .octograph with no board, and still never creates .octobots", () => {
    const root = mkdtempClean("art-");
    writeArtifact(resolveOut(root, DEFAULTS), {
      version: 1,
      clusters: { 0: ["a.ts"] },
      config: DEFAULTS,
    });
    expect(existsSync(join(root, ".octograph", "clusters.json"))).toBe(true);
    expect(existsSync(join(root, ".octobots"))).toBe(false);
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

  /**
   * A committed artifact survives merges, hand edits and version bumps, so
   * "valid JSON that is not a StoredGraph" is a real state on disk — and
   * handing it back verbatim moves the failure one frame up, into
   * `Object.entries(previous.clusters)`, which throws
   * `TypeError: Cannot convert undefined or null to object` and takes the
   * whole run down. Every one of these parses cleanly; none is a v1 artifact.
   */
  it.each([
    ["an empty object", "{}"],
    ["a null document", "null"],
    ["a bare scalar", "42"],
    ["an array", "[]"],
    ["a future version", '{"version":2,"clusters":{"0":["a.ts"]}}'],
    ["clusters of the wrong type", '{"version":1,"clusters":[]}'],
    ["a cluster whose members are not strings", '{"version":1,"clusters":{"0":[1,2]}}'],
    ["a cluster that is not a list", '{"version":1,"clusters":{"0":"a.ts"}}'],
  ])("returns null for %s rather than a value that crashes its consumer", (_name, body) => {
    const dir = mkdtempClean("art-");
    writeFileSync(join(dir, "clusters.json"), body);
    expect(readArtifact(dir)).toBeNull();
  });

  it("returns null for an unparseable file (a truncated write, a merge conflict)", () => {
    const dir = mkdtempClean("art-");
    writeFileSync(join(dir, "clusters.json"), '{"version":1,"clusters":{"0":["a.ts"');
    expect(readArtifact(dir)).toBeNull();
  });
});

describe("byte stability of the committed artifact", () => {
  it("writes byte-identical output for two writes of identical input", () => {
    const dir = mkdtempClean("art-");
    const graph: StoredGraph = {
      version: 1,
      clusters: { 2: ["b.ts", "a.ts"], 1: ["c.ts"] },
      config: DEFAULTS,
    };

    writeArtifact(dir, graph);
    const first = readFileSync(join(dir, "clusters.json"), "utf8");

    writeArtifact(dir, graph);
    const second = readFileSync(join(dir, "clusters.json"), "utf8");

    expect(second).toBe(first);
  });

  /**
   * The same document assembled in a different key order is the same document.
   * Object key order is INSERTION order, so `{...graph}` copies whatever order
   * the caller's literal happened to use straight into the file: reordering the
   * fields of the `StoredGraph` literal in cli.ts, or of the `Config` literal
   * in config.ts, would rewrite the whole committed artifact while changing
   * nothing about the graph. That is churn indistinguishable from real change
   * in the diff the artifact exists to make readable.
   */
  it("writes byte-identical output regardless of the key order of the input literals", () => {
    const forward: Config = {
      maxCommitFiles: 50,
      halfLifeDays: 180,
      minSupport: 2,
      minCommits: 200,
      hubZThreshold: 3,
      budgetTokens: 2000,
      out: null,
    };
    const reversed: Config = {
      out: null,
      budgetTokens: 2000,
      hubZThreshold: 3,
      minCommits: 200,
      minSupport: 2,
      halfLifeDays: 180,
      maxCommitFiles: 50,
    };

    const a = mkdtempClean("art-");
    writeArtifact(a, { version: 1, clusters: { 1: ["a.ts"] }, config: forward });

    const b = mkdtempClean("art-");
    writeArtifact(b, { config: reversed, clusters: { 1: ["a.ts"] }, version: 1 });

    expect(readFileSync(join(b, "clusters.json"), "utf8")).toBe(
      readFileSync(join(a, "clusters.json"), "utf8"),
    );
  });

  it("carries an unknown top-level key through instead of dropping it", () => {
    const dir = mkdtempClean("art-");
    // A field added to StoredGraph by a later task must not be silently lost
    // by the ordering pass — the dropped-field failure mode that cost the
    // board a decision record once already.
    const withExtra = {
      version: 1,
      clusters: { 1: ["a.ts"] },
      config: DEFAULTS,
      generatedBy: "t3.4",
    } as unknown as StoredGraph;
    writeArtifact(dir, withExtra);
    const raw = JSON.parse(readFileSync(join(dir, "clusters.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw.generatedBy).toBe("t3.4");
  });

  it("orders cluster keys numerically and members alphabetically regardless of input order", () => {
    const dir = mkdtempClean("art-");
    writeArtifact(dir, { version: 1, clusters: { 10: ["z.ts", "a.ts"], 2: ["y.ts"] }, config: DEFAULTS });

    const raw = readFileSync(join(dir, "clusters.json"), "utf8");
    expect(raw.indexOf('"2"')).toBeLessThan(raw.indexOf('"10"'));
    expect(raw.indexOf('"a.ts"')).toBeLessThan(raw.indexOf('"z.ts"'));
  });
});
