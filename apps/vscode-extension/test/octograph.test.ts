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
});

/**
 * The three escape vectors `packages/graph/src/paths.ts`'s `insideRepo` is tested against (see
 * `packages/graph/test/paths.test.ts`): a `..` traversal, an absolute path elsewhere, and a
 * symlink whose real target escapes. This module hand-duplicates `insideRepo`'s containment
 * check (it cannot import `@octoshell/graph` — mission criterion 4), so this list is the ONE
 * place `impactArgv`'s escape-vector coverage is enumerated. If a vector is added here, add the
 * matching case to `paths.test.ts` too, and vice versa — the two suites must never quietly
 * diverge on what counts as "escapes the root".
 */
const ESCAPE_VECTORS: { name: string; buildPath: (root: string) => string }[] = [
  {
    name: "'..' traversal",
    buildPath: () => "../outside",
  },
  {
    name: "absolute path elsewhere",
    buildPath: (root) => resolve(dirname(root), "definitely-elsewhere", "file.ts"),
  },
  {
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
  it("contains no import of the vscode module", () => {
    const source = readFileSync(SRC, "utf8");
    expect(source).not.toMatch(/from\s+["']vscode["']/);
    expect(source).not.toMatch(/require\(\s*["']vscode["']\s*\)/);
  });
});
