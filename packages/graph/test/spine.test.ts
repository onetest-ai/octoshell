import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredSpine } from "../src/spine.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spine-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("declaredSpine", () => {
  it("prefers workspace manifests over directories", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/one/package.json": '{"name":"one"}',
      "packages/two/package.json": '{"name":"two"}',
    });
    const spine = declaredSpine(root, ["packages/one/a.ts", "packages/two/b.ts"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("packages/one/a.ts")).toBe("packages/one");
  });

  it("falls back to top-level directories with no manifest", () => {
    const root = repoWith({ "README.md": "hi" });
    const spine = declaredSpine(root, ["src/a/x.ts", "docs/b.md"]);
    expect(spine.source).toBe("directories");
    expect(spine.moduleOf("src/a/x.ts")).toBe("src/a");
  });

  it("lists every module it found", () => {
    const root = repoWith({ "README.md": "hi" });
    const spine = declaredSpine(root, ["src/a/x.ts", "src/b/y.ts"]);
    expect(spine.modules.sort()).toEqual(["src/a", "src/b"]);
  });

  it("returns modules already sorted, whatever order the files arrive in", () => {
    const root = repoWith({ "README.md": "hi" });
    const spine = declaredSpine(root, ["src/z/y.ts", "src/a/x.ts", "src/m/w.ts"]);
    // Not `.sort()`ed by the assertion: the artifact is committed, so the
    // order the caller receives is the order that lands in the diff.
    expect(spine.modules).toEqual(["src/a", "src/m", "src/z"]);
  });

  it("ignores workspace-file list entries outside the `packages:` key", () => {
    // pnpm 10 writes `onlyBuiltDependencies` into pnpm-workspace.yaml itself.
    // Read as a package glob, the build dependency's name becomes a module
    // root and swallows the real `core/*` modules under one flat `core`.
    const root = repoWith({
      "pnpm-workspace.yaml":
        "packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n  - core\n  - esbuild\n",
      "packages/one/package.json": '{"name":"one"}',
      "core/deep/x.ts": "",
    });
    const spine = declaredSpine(root, ["packages/one/a.ts", "core/deep/x.ts", "core/wide/y.ts"]);
    expect(spine.moduleOf("core/deep/x.ts")).toBe("core/deep");
    expect(spine.modules).toEqual(["core/deep", "core/wide", "packages/one"]);
  });

  it("does not call a repo with no `packages:` key a manifest workspace", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n",
      "README.md": "hi",
    });
    expect(declaredSpine(root, ["src/a/x.ts"]).source).toBe("directories");
  });

  it("keeps reading a workspace directory past a broken symlink", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/one/package.json": '{"name":"one"}',
    });
    // A stale worktree link or a removed local dependency. `statSync` follows
    // the link and throws ENOENT, which used to take the whole spine down.
    symlinkSync(join(root, "does-not-exist"), join(root, "packages", "broken"));
    const spine = declaredSpine(root, ["packages/one/a.ts"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("packages/one/a.ts")).toBe("packages/one");
  });

  it("refuses a workspace glob that escapes the repo root", () => {
    // `readdirSync` on the repo's parent would enumerate its siblings and put
    // their names into a committed artifact.
    const root = repoWith({ "pnpm-workspace.yaml": "packages:\n  - '../*'\n", "README.md": "hi" });
    const spine = declaredSpine(root, ["src/a/x.ts"]);
    expect(spine.source).toBe("directories");
    expect(spine.modules).toEqual(["src/a"]);
  });

  it("does not treat a `!` exclusion as a module root", () => {
    // An exclusion declares nothing, so a file that isn't under a real root
    // must still fall through to the directory rule.
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - '!packages/private'\n",
      "README.md": "hi",
    });
    const spine = declaredSpine(root, ["src/a/x.ts"]);
    expect(spine.source).toBe("directories");
    expect(spine.modules).toEqual(["src/a"]);
  });

  it("discovers two Go modules recursively and treats their directories as module boundaries", () => {
    const root = repoWith({
      "alpha/go.mod": "module alpha\n",
      "beta/go.mod": "module beta\n",
    });
    const spine = declaredSpine(root, ["alpha/pkg/server/main.go", "beta/cmd/main.go"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("alpha/pkg/server/main.go")).toBe("alpha");
    expect(spine.moduleOf("beta/cmd/main.go")).toBe("beta");
  });

  it("discovers two Rust crates recursively and treats their directories as module boundaries", () => {
    const root = repoWith({
      "crates/alpha/Cargo.toml": '[package]\nname = "alpha"\n',
      "crates/beta/Cargo.toml": '[package]\nname = "beta"\n',
    });
    const spine = declaredSpine(root, ["crates/alpha/src/lib.rs", "crates/beta/src/lib.rs"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("crates/alpha/src/lib.rs")).toBe("crates/alpha");
    expect(spine.moduleOf("crates/beta/src/lib.rs")).toBe("crates/beta");
  });

  it("discovers two Python packages recursively and treats their directories as module boundaries", () => {
    const root = repoWith({
      "apps/alpha/pyproject.toml": '[project]\nname = "alpha"\n',
      "apps/beta/pyproject.toml": '[project]\nname = "beta"\n',
    });
    const spine = declaredSpine(root, ["apps/alpha/src/main.py", "apps/beta/src/main.py"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("apps/alpha/src/main.py")).toBe("apps/alpha");
    expect(spine.moduleOf("apps/beta/src/main.py")).toBe("apps/beta");
  });

  it("treats a single root-level manifest marker as a fact, not a boundary set", () => {
    // A lone `go.mod` at the repo root would otherwise map every file to ".",
    // which makes `rollUp` drop every edge as intra-module and renders a
    // one-node map with no dependencies. This is the deliberate behaviour —
    // don't "fix" it back to pushing "." as a module root.
    const root = repoWith({ "go.mod": "module solo\n" });
    const spine = declaredSpine(root, ["main.go", "internal/util.go"]);
    expect(spine.source).toBe("directories");
  });

  it("lets an explicit workspace manifest win over a nested go.mod", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/one/package.json": '{"name":"one"}',
      "services/backend/api/go.mod": "module api\n",
      "services/backend/api/main.go": "",
    });
    const spine = declaredSpine(root, [
      "packages/one/a.ts",
      "services/backend/api/main.go",
    ]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("packages/one/a.ts")).toBe("packages/one");
    // The nested go.mod must not carve out its own boundary here — the file
    // falls through to the two-segment convention, not "services/backend/api".
    expect(spine.moduleOf("services/backend/api/main.go")).toBe("services/backend");
  });

  it("ignores a manifest marker inside node_modules or vendor", () => {
    const root = repoWith({
      "node_modules/some-dep/go.mod": "module dep\n",
      "vendor/thing/Cargo.toml": '[package]\nname = "thing"\n',
      "services/a/go.mod": "module a\n",
    });
    // Only one marker outside the ignored directories, so this must still
    // read as a single module, not a boundary set.
    const spine = declaredSpine(root, ["services/a/main.go"]);
    expect(spine.source).toBe("directories");
  });

  it("takes edges from graphify while keeping manifest boundaries", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
      "services/team-a/package.json": '{"name":"a"}',
      "services/team-b/package.json": '{"name":"b"}',
      "graphify-out/graph.json": JSON.stringify({
        nodes: [
          { id: "1", file: "services/team-a/src/x.ts" },
          { id: "2", file: "services/team-b/src/y.ts" },
        ],
        edges: [{ source: "1", target: "2", type: "imports" }],
      }),
    });
    const spine = declaredSpine(root, [
      "services/team-a/src/x.ts",
      "services/team-b/src/y.ts",
    ]);
    expect(spine.source).toBe("graphify");
    expect(spine.imports.length).toBeGreaterThan(0);
    // Boundaries still come from the manifest, NOT the two-segment fallback:
    // "services/team-a", never "services/team".
    expect(spine.moduleOf("services/team-a/src/x.ts")).toBe("services/team-a");
  });

  // The two lists in a Spine must be ordered by the same rule. `modules` uses
  // plain `.sort()` (code units); if `imports` used `localeCompare`, a repo with
  // a capitalized module directory would emit a committed artifact whose edge
  // order contradicts its own module order — and would additionally reorder on
  // nothing but a change of LANG.
  it("orders imports by the same collation as modules", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'Sources/*'\n",
      "Sources/Zed/package.json": '{"name":"zed"}',
      "Sources/alpha/package.json": '{"name":"alpha"}',
      "Sources/common/package.json": '{"name":"common"}',
      "graphify-out/graph.json": JSON.stringify({
        nodes: [
          { id: "z", file: "Sources/Zed/x.ts" },
          { id: "a", file: "Sources/alpha/y.ts" },
          { id: "c", file: "Sources/common/z.ts" },
        ],
        edges: [
          { source: "a", target: "c", type: "imports" },
          { source: "z", target: "c", type: "imports" },
        ],
      }),
    });
    const spine = declaredSpine(root, [
      "Sources/Zed/x.ts",
      "Sources/alpha/y.ts",
      "Sources/common/z.ts",
    ]);
    expect(spine.source).toBe("graphify");
    expect(spine.modules).toEqual(["Sources/Zed", "Sources/alpha", "Sources/common"]);
    expect(spine.imports.map((e) => e.from)).toEqual(["Sources/Zed", "Sources/alpha"]);
  });

  it("expands a nested wildcard glob (`services/*/*`)", () => {
    // The open defect: the hand-rolled scanner only expanded a single trailing
    // `/*`, so `services/*/*` silently produced zero roots and the map fell
    // back to the crude two-segment "directories" tier.
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'services/*/*'\n",
      "services/team-a/api/package.json": '{"name":"api"}',
      "services/team-b/web/package.json": '{"name":"web"}',
    });
    const spine = declaredSpine(root, [
      "services/team-a/api/x.ts",
      "services/team-b/web/y.ts",
    ]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("services/team-a/api/x.ts")).toBe("services/team-a/api");
    expect(spine.moduleOf("services/team-b/web/y.ts")).toBe("services/team-b/web");
  });

  it("parses a flow-sequence `packages:` list (`[pkg-a, pkg-b]`)", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages: [pkg-a, pkg-b]\n",
      "pkg-a/package.json": '{"name":"pkg-a"}',
      "pkg-b/package.json": '{"name":"pkg-b"}',
    });
    const spine = declaredSpine(root, ["pkg-a/x.ts", "pkg-b/y.ts"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("pkg-a/x.ts")).toBe("pkg-a");
    expect(spine.moduleOf("pkg-b/y.ts")).toBe("pkg-b");
  });

  it("parses quoted and unquoted entries alongside a comment line inside the block", () => {
    const root = repoWith({
      "pnpm-workspace.yaml":
        "packages:\n  - 'packages/one' # single-quoted\n  - \"packages/two\"\n  # a comment line, no entry\n  - packages/three\n",
      "packages/one/package.json": '{"name":"one"}',
      "packages/two/package.json": '{"name":"two"}',
      "packages/three/package.json": '{"name":"three"}',
    });
    const spine = declaredSpine(root, [
      "packages/one/a.ts",
      "packages/two/b.ts",
      "packages/three/c.ts",
    ]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("packages/one/a.ts")).toBe("packages/one");
    expect(spine.moduleOf("packages/two/b.ts")).toBe("packages/two");
    expect(spine.moduleOf("packages/three/c.ts")).toBe("packages/three");
  });

  it("still does not let `onlyBuiltDependencies` contribute a root, through the real parser", () => {
    // Regression pin for the already-patched defect, now guarded structurally
    // (reading the parsed `packages` key) instead of by a scoped regex.
    const root = repoWith({
      "pnpm-workspace.yaml":
        "packages:\n  - 'packages/*'\nonlyBuiltDependencies: [core]\n",
      "packages/one/package.json": '{"name":"one"}',
      "core/deep/x.ts": "",
    });
    const spine = declaredSpine(root, ["packages/one/a.ts", "core/deep/x.ts", "core/wide/y.ts"]);
    expect(spine.moduleOf("core/deep/x.ts")).toBe("core/deep");
    expect(spine.modules).toEqual(["core/deep", "core/wide", "packages/one"]);
  });

  it("still skips a quoted `!` exclusion entry on its own, with the real parser", () => {
    // Same scenario as "does not treat a `!` exclusion as a module root"
    // above, but exercised alongside a real `packages/*` glob in the same
    // list — the exclusion's own tag-like `!` prefix must not trip up
    // js-yaml's tag parsing when quoted, and must still be filtered before
    // expansion rather than becoming a root string of its own.
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - '!packages/private'\n",
      "apps/one/package.json": '{"name":"one"}',
    });
    const spine = declaredSpine(root, ["apps/one/a.ts"]);
    expect(spine.source).toBe("manifests");
    expect(spine.modules).toEqual(["apps/one"]);
    expect(spine.moduleOf("apps/one/a.ts")).toBe("apps/one");
  });

  /**
   * The regression this test exists for (M2 bug: `insideRepo` did not
   * resolve symlinks).
   *
   * Exercises the real call site, not just the unit-level `insideRepo`
   * check: `discoverManifestRoots`'s walk calls `existsSync(join(abs,
   * marker))` for every directory it visits, and `existsSync` follows
   * symlinks. The repo declares only ONE real marker (`alpha/go.mod`) —
   * alone, that must read as a single-module repo, not a manifest-boundary
   * one (see "treats a single root-level manifest marker as a fact, not a
   * boundary set" above). Pre-fix, `insideRepo(repoRoot, "escape")` passed
   * containment on string math alone, so the walk followed the symlink,
   * found the OUTSIDE directory's `go.mod`, and counted it as a SECOND
   * marker — flipping `spine.source` from "directories" to "manifests" on
   * the strength of content that was never part of the repo, and would have
   * gone on to `readdirSync` that outside directory's structure too.
   */
  it("does not let a symlinked directory that escapes the repo contribute a manifest-marker module boundary", () => {
    const outside = mkdtempSync(join(tmpdir(), "spine-outside-"));
    writeFileSync(join(outside, "go.mod"), "module escaped\n");

    const root = repoWith({ "alpha/go.mod": "module alpha\n" });
    symlinkSync(outside, join(root, "escape"));

    const spine = declaredSpine(root, ["alpha/pkg/main.go"]);
    expect(spine.source).toBe("directories");
    // The escaping symlink must not have become a recognised module root.
    expect(spine.modules).not.toContain("escape");
  });

  it("degrades to the directories tier on malformed YAML instead of throwing", () => {
    const root = repoWith({
      // Unbalanced flow-sequence bracket: a genuine YAML parse error.
      "pnpm-workspace.yaml": "packages: [packages/one, packages/two\n",
      "packages/one/package.json": '{"name":"one"}',
    });
    expect(() => declaredSpine(root, ["packages/one/a.ts"])).not.toThrow();
    const spine = declaredSpine(root, ["packages/one/a.ts"]);
    expect(spine.source).toBe("directories");
    expect(spine.moduleOf("packages/one/a.ts")).toBe("packages/one");
  });
});
