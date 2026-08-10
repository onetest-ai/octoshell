import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepo } from "./fixtures/repo.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_PATH = join(PKG_ROOT, "dist", "octograph.mjs");

interface Run {
  code: number;
  stdout: string;
}

/** `execFileSync` throws on a non-zero exit — `doctor` legitimately exits
 *  non-zero for a thin-history fixture, so this captures the exit code
 *  instead of treating it as a test failure. */
function runNode(args: string[], cwd: string): Run {
  try {
    const stdout = execFileSync("node", args, { cwd, stdio: "pipe" }).toString();
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number | null; stdout: Buffer };
    return { code: e.status ?? 1, stdout: e.stdout.toString() };
  }
}

describe("scripts/bundle.mjs", () => {
  it(
    "emits a single self-contained .mjs that runs doctor under bare node with no node_modules",
    () => {
      // Produced by the SAME script `pnpm --filter @octoshell/graph bundle`
      // invokes (package.json's "bundle" script is `node scripts/bundle.mjs`)
      // — never a hand-maintained second copy of the CLI.
      execFileSync("node", ["scripts/bundle.mjs"], { cwd: PKG_ROOT, stdio: "pipe" });
      expect(existsSync(BUNDLE_PATH)).toBe(true);

      // A fresh git repo under the OS temp dir has no `node_modules` of its
      // own — running the bundle with THAT as cwd is the proof that nothing
      // it does at runtime reaches back into this package's node_modules
      // (js-yaml included) rather than the code esbuild inlined.
      const repo = buildRepo(Array.from({ length: 3 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })));
      expect(existsSync(join(repo, "node_modules"))).toBe(false);

      const result = runNode([BUNDLE_PATH, "doctor"], repo);
      expect(result.stdout).toContain("status:");
    },
    30_000,
  );
});
