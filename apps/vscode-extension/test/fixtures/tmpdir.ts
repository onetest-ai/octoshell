import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * A scratch directory under the OS temp dir that removes itself when the test that created it
 * finishes — pass or fail. Mirrors `packages/graph/test/fixtures/tmpdir.ts`'s `mkdtempClean`
 * (same name, same shape) so a fixture repo in this app's test suite never leaks the way a bare
 * `mkdtempSync` does: nothing here removes the directory a raw `mkdtempSync` call creates, so it
 * (and, for board fixtures, its `.git` object database) accumulates on disk across every run.
 *
 * `onTestFinished` fires on pass, fail, or throw alike, so cleanup is a property of CREATING the
 * directory, not a step a caller can forget to add.
 */
export function mkdtempClean(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
