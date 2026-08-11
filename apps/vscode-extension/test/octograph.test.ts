import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactPath,
  conflictsArgv,
  graphCommand,
  impactArgv,
} from "../src/host/octograph.js";
import { GRAPH_RELATIVE_PATH } from "../src/host/octograph-install.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const SRC = join(__dirname, "..", "src", "host", "octograph.ts");

/** `packages/graph/test/paths.test.ts` — the twin suite this one's escape-vector list is pinned
 *  to. Read, never imported: the extension has no dependency on `@octoshell/graph` (criterion 4)
 *  and this must not create one. A rename breaks the read loudly rather than silently passing. */
const TWIN_SUITE = join(__dirname, "..", "..", "..", "packages", "graph", "test", "paths.test.ts");

describe("graphCommand", () => {
  it("produces the documented bare-node invocation for setup", () => {
    expect(graphCommand("setup")).toBe(`node ${GRAPH_RELATIVE_PATH} setup`);
  });

  it("produces the documented bare-node invocation for map", () => {
    expect(graphCommand("map")).toBe(`node ${GRAPH_RELATIVE_PATH} map`);
  });

  it("never mentions npx or a network URL", () => {
    for (const cmd of ["setup", "map"] as const) {
      expect(graphCommand(cmd)).not.toMatch(/npx|https?:\/\//);
    }
  });
});

describe("artifactPath", () => {
  it("resolves .octobots/graph when a board exists", () => {
    const repo = mkdtempClean("octograph-artifact-");
    mkdirSync(join(repo, ".octobots"), { recursive: true });
    expect(artifactPath(repo)).toBe(join(repo, ".octobots", "graph"));
  });

  it("resolves .octograph when no board exists", () => {
    const repo = mkdtempClean("octograph-artifact-");
    expect(artifactPath(repo)).toBe(join(repo, ".octograph"));
  });

  it("does NOT honour octograph.yaml's `out:` — the one resolveOut branch it does not mirror", () => {
    // Pins the documented gap so it stays visible instead of being rediscovered by a consumer
    // that trusted "where the artifact is". `packages/graph/src/artifact.ts`'s `resolveOut`
    // returns `resolve(repoRoot, config.out)` when `out:` is set and containment-clean — it wins
    // over BOTH branches above — so for such a workspace this function's answer and the real run's
    // answer differ. Covering it would need a third spelling of `loadConfig`'s YAML read plus its
    // containment check, neither importable here (criterion 4). If a future task closes the gap,
    // this test fails and forces the doc comment on `artifactPath` to be corrected with it.
    const repo = mkdtempClean("octograph-artifact-");
    writeFileSync(join(repo, "octograph.yaml"), "out: build/graph\n");
    expect(artifactPath(repo)).toBe(join(repo, ".octograph"));
    expect(artifactPath(repo)).not.toBe(join(repo, "build", "graph"));
  });
});

/**
 * The escape vectors `impactArgv`'s containment check is tested against — and, because that check
 * is a hand-duplicated TWIN of `packages/graph/src/paths.ts`'s `insideRepo` (unimportable here,
 * mission criterion 4), the vectors `insideRepo` must be tested against too.
 *
 * This is HALF of one shared list, not two lists that happen to look alike. Each entry's `id`
 * matches an `// escape-vector: <id>` marker on the corresponding case in
 * `packages/graph/test/paths.test.ts`, and the "escape-vector lists agree" guard below fails when
 * the two sets differ in either direction. That guard is not decoration: when it was written the
 * lists HAD already diverged — `absolute-elsewhere` was tested only here, while a comment in three
 * places (this file, `octograph.ts`, the PR body) claimed all three were tested on both sides.
 */
const ESCAPE_VECTORS: { id: string; name: string; buildPath: (root: string) => string }[] = [
  {
    id: "dotdot-traversal",
    name: "'..' traversal",
    buildPath: () => "../outside",
  },
  {
    id: "absolute-elsewhere",
    name: "absolute path elsewhere",
    buildPath: (root) => resolve(dirname(root), "definitely-elsewhere", "file.ts"),
  },
  {
    id: "symlink-escape",
    name: "symlink whose target escapes",
    buildPath: (root) => {
      const outside = mkdtempClean("octograph-outside-");
      writeFileSync(join(outside, "secret.txt"), "outside content\n");
      mkdirSync(join(root, "packages"), { recursive: true });
      symlinkSync(outside, join(root, "packages", "escape"));
      return "packages/escape/secret.txt";
    },
  },
];

describe("impactArgv — path containment", () => {
  for (const vector of ESCAPE_VECTORS) {
    it(`rejects a path that escapes the workspace root via ${vector.name}`, () => {
      const root = mkdtempClean("octograph-impact-");
      const path = vector.buildPath(root);
      expect(impactArgv(root, path)).toBeNull();
    });
  }

  it("rejects a path containing a shell metacharacter, outright, not escaped or quoted", () => {
    const root = mkdtempClean("octograph-impact-");
    const dangerous = ["src/a; rm -rf /", "src/a && echo hi", "src/$(whoami)", "src/`whoami`", "src/a|b", "src/a>out"];
    for (const path of dangerous) {
      expect(impactArgv(root, path)).toBeNull();
    }
  });

  it("accepts a legitimate path with spaces and dots, as its own argv element with no quoting applied", () => {
    const root = mkdtempClean("octograph-impact-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "my file.test.ts"), "");
    const argv = impactArgv(root, "src/my file.test.ts");
    expect(argv).not.toBeNull();
    expect(argv).toContain("src/my file.test.ts");
    // Never quoted or escaped by us — the raw string, verbatim, as its own element.
    expect(argv).not.toContain('"src/my file.test.ts"');
    expect(argv).not.toContain("src/my\\ file.test.ts");
  });

  it("builds the documented argv with no npx and no network", () => {
    const root = mkdtempClean("octograph-impact-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "");
    const argv = impactArgv(root, "src/foo.ts");
    expect(argv).toEqual(["node", GRAPH_RELATIVE_PATH, "impact", "src/foo.ts"]);
  });

  it("rejects an empty path rather than emitting an empty argv element", () => {
    // `resolve(root, "")` is the root itself, so containment ALONE accepts `""` and the argv
    // would carry an empty element — a value no caller means and every downstream string-join
    // (`sendText`, a shell history entry) renders as nothing at all. Reject at the seam.
    const root = mkdtempClean("octograph-impact-");
    expect(impactArgv(root, "")).toBeNull();
    expect(impactArgv(root, "   ")).toBeNull();
  });
});

describe("escape-vector lists agree with the twin suite", () => {
  /**
   * The pin that makes the duplicated containment rule VISIBLE rather than silently re-derived.
   *
   * `impactArgv`'s containment check is a second spelling of `packages/graph/src/paths.ts`'s
   * `insideRepo` — unimportable here by mission criterion 4 — so nothing but a test can keep the
   * two honest about which escapes they cover. This reads the twin suite's
   * `// escape-vector: <id>` markers and requires the set to equal {@link ESCAPE_VECTORS}'s ids,
   * in BOTH directions: adding a vector on either side without the other is a red test.
   *
   * Proven, not assumed: this guard failed on the tree it was written against
   * (`absolute-elsewhere` was tested only in the extension suite, while three separate comments
   * claimed both suites tested all three).
   */
  it("has the same vector ids as packages/graph/test/paths.test.ts", () => {
    const twin = readFileSync(TWIN_SUITE, "utf8");
    const marked = [...twin.matchAll(/\/\/\s*escape-vector:\s*([a-z0-9-]+)/g)].map((m) => m[1]);
    expect(marked.length).toBeGreaterThan(0); // a rename/rewrite that drops the markers is a failure, not a pass
    expect([...marked].sort()).toEqual(ESCAPE_VECTORS.map((v) => v.id).sort());
  });
});

describe("conflictsArgv — task-id validation", () => {
  it("accepts safe-slug task ids and builds the documented argv", () => {
    const argv = conflictsArgv(["t6-2-octograph-ts", "t6-3-command"]);
    expect(argv).toEqual(["node", GRAPH_RELATIVE_PATH, "conflicts", "t6-2-octograph-ts", "t6-3-command"]);
  });

  it("rejects a non-slug task id outright", () => {
    // Everything a path validator would accept but a slug validator must not: spaces, dots,
    // slashes, shell metacharacters.
    for (const id of ["../escape", "t6 2", "t6.2", "t6/2", "t6;rm -rf /"]) {
      expect(conflictsArgv([id])).toBeNull();
    }
  });

  it("rejects an empty id list", () => {
    expect(conflictsArgv([])).toBeNull();
  });

  it("is unreachable from impactArgv's call site and vice versa — distinct validators", () => {
    // A path (with slashes and dots) is exactly what the slug validator must reject, and a
    // bare task-id slug is exactly what a caller could mistake for "a relative path with no
    // directory" — so neither function is a synonym for the other.
    const root = mkdtempClean("octograph-crosscheck-");
    // A real slug is NOT a valid path unless the file exists — impactArgv only rejects paths
    // that escape the root or carry a metacharacter, so a bare slug that happens to name a
    // nonexistent in-repo file still passes containment (path validation deliberately does not
    // require existence). The real distinction under test: a genuine path shape (with `/`) is
    // rejected by the slug validator, proving the two functions apply different rules.
    expect(conflictsArgv(["src/foo.ts"])).toBeNull();
    expect(impactArgv(root, "../outside")).toBeNull();
  });
});

describe("octograph.ts imports vscode nowhere", () => {
  /**
   * Every syntactic way the `vscode` module specifier can enter this file, not just the static
   * `from "vscode"` form. A DYNAMIC `await import("vscode")` is the realistic edit that slipped
   * past the original two patterns — esbuild bundles it and the extension host resolves it, so it
   * works at runtime and nothing else in the suite would have noticed; this module would just
   * quietly stop being unit-testable outside a host. Verified by planting each form in turn and
   * watching this test go red, then removing it.
   */
  it("names the vscode module in no import form — static, dynamic, bare, or require", () => {
    const source = readFileSync(SRC, "utf8");
    // Strip comments first: the doc comments here TALK about `vscode.Terminal.sendText` and
    // `vscode` the API, and a guard that trips on prose is a guard people delete.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const pattern of [
      /from\s+["']vscode["']/, // import x from "vscode"
      /import\s*\(\s*["']vscode["']\s*\)/, // await import("vscode")
      /import\s+["']vscode["']/, // import "vscode"
      /require\s*\(\s*["']vscode["']\s*\)/, // require("vscode")
    ]) {
      expect(code).not.toMatch(pattern);
    }
  });
});
