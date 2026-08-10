import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * The one place this suite creates a scratch directory under the OS temp dir
 * — every test-fixture helper (`buildRepo`, `repoWith`, `repoWithGraph`, and
 * every inline `it()` that needs a throwaway repo root) goes through this,
 * never a raw `mkdtempSync` of its own. `test/conventions.test.ts` enforces
 * that structurally, mirroring the source-level guards it already applies to
 * `edgeWeight`/`compare`/the clock.
 *
 * Registers its own removal via `onTestFinished`, so cleanup is a property of
 * CREATING the directory, not a step a caller can forget to add — the same
 * defect class as an open-coded rule, applied to 31+ call sites instead of
 * one function body. `onTestFinished` fires on pass, fail, or throw alike, so
 * a fixture is removed even when the test it backs does not.
 *
 * Pre-fix, nothing in this suite ever removed a fixture repo: 31 `buildRepo`
 * call sites plus several more direct `mkdtempSync` calls, each with its own
 * `.git` object database, accumulated on disk across every run. Locally that
 * is invisible — a dev machine's temp filesystem is large and nobody looks —
 * but CI's is bounded, and `git add`'s own temporary index file is what fails
 * to create once it fills up. The failure lands on whichever test happens to
 * run the most git invocations, but every fixture this suite has ever built
 * contributed to it.
 */
export function mkdtempClean(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
