import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
