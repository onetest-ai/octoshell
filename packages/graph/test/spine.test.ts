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
});
