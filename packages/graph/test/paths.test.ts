import { describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { insideRepo, repoRelative } from "../src/paths.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/** The root through the SAME resolved namespace `insideRepo` compares
 *  against — the OS temp dir itself can sit behind a symlink (macOS's `/var`
 *  -> `/private/var`), so a literal `resolve(root, ...)` is not always what
 *  a correct, root-consistent result looks like. */
function realRoot(root: string): string {
  return realpathSync(root);
}

describe("insideRepo", () => {
  it("resolves a plain relative path inside the repo", () => {
    const root = mkdtempClean("octograph-paths-");
    expect(insideRepo(root, "packages/a/x.ts")).toBe(
      resolve(realRoot(root), "packages/a/x.ts"),
    );
  });

  it("rejects a plain relative path that escapes via '..'", () => {
    const root = mkdtempClean("octograph-paths-");
    expect(insideRepo(root, "../outside")).toBeNull();
  });

  it("is pure string math for a path that does not exist on disk", () => {
    // Doc contract: `insideRepo` never touches the filesystem for the
    // CANDIDATE path when it names a file that does not exist —
    // `fs.realpathSync` would throw ENOENT for it, and that throw must not
    // escape. The repo ROOT itself is still resolved (it is expected to
    // exist), so the expectation is built from the root's real path, not a
    // literal `resolve(root, ...)`.
    const root = mkdtempClean("octograph-paths-");
    expect(insideRepo(root, "no/such/file.ts")).toBe(
      resolve(realRoot(root), "no/such/file.ts"),
    );
  });

  /**
   * The regression this test exists for (M2 bug).
   *
   * octograph is pointed at checkouts nobody on this team wrote, so the
   * repo's own content — including a symlink placed inside it — must be
   * treated as potentially hostile input, not trusted structure. Pre-fix,
   * `insideRepo` was pure string math over `path.resolve`, so a symlink
   * *inside* the repo pointing *outside* it passed containment (the string
   * itself never left the root) and was only followed later, unguarded, by
   * `statSync`/`readdirSync` in spine.ts's directory walks.
   */
  it("rejects a path reached through a symlink that escapes the repo root", () => {
    const outside = mkdtempClean("octograph-outside-");
    writeFileSync(join(outside, "secret.txt"), "outside content\n");
    const root = mkdtempClean("octograph-paths-");
    mkdirSync(join(root, "packages"), { recursive: true });
    symlinkSync(outside, join(root, "packages", "escape"));

    expect(insideRepo(root, "packages/escape")).toBeNull();
    // And a real file reached THROUGH the escaping symlink is rejected too,
    // not just the symlink's own location.
    expect(insideRepo(root, "packages/escape/secret.txt")).toBeNull();
  });

  /**
   * The legitimate case a naive "reject any symlink component" fix would
   * have broken: a real package directory reached through a symlink is an
   * ordinary monorepo pattern (a workspace tool symlinking
   * `node_modules/@scope/pkg` back to `packages/pkg`, for instance). Its REAL
   * target is inside the repo, so it must still resolve as inside — which is
   * exactly why this function resolves-then-compares rather than rejecting
   * any path with a symlink component outright.
   */
  it("resolves a symlink inside the repo that points to another location inside the repo", () => {
    const root = mkdtempClean("octograph-paths-");
    mkdirSync(join(root, "packages", "real"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(root, "packages", "real"), join(root, "node_modules", "linked"));

    const result = insideRepo(root, "node_modules/linked");
    expect(result).not.toBeNull();
    // Compared against the REAL path, not the literal `resolve(...)` string:
    // the OS temp dir itself can sit behind a symlink (macOS's `/var` ->
    // `/private/var`), which a resolved candidate is compared against on
    // equal footing.
    expect(result).toBe(realpathSync(resolve(root, "packages/real")));
  });
});

describe("repoRelative", () => {
  it("normalizes an inside path to a forward-slash repo-relative path", () => {
    const root = mkdtempClean("octograph-paths-");
    expect(repoRelative(root, "packages/a/x.ts")).toBe("packages/a/x.ts");
  });

  it("returns null for a path escaping through a symlink", () => {
    const outside = mkdtempClean("octograph-outside-");
    writeFileSync(join(outside, "file.ts"), "outside content\n");
    const root = mkdtempClean("octograph-paths-");
    symlinkSync(outside, join(root, "escape"));
    expect(repoRelative(root, "escape/file.ts")).toBeNull();
  });
});
