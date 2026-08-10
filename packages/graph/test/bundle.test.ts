import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_PATH = join(PKG_ROOT, "dist", "octograph.mjs");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** `execFileSync` throws on a non-zero exit — `doctor` legitimately exits
 *  non-zero for a thin-history fixture, so this captures the exit code
 *  instead of treating it as a test failure. `stderr` is captured too: the
 *  failure this test guards against (an un-inlined dependency) shows up as an
 *  empty stdout and an ERR_MODULE_NOT_FOUND on stderr, and an assertion that
 *  can only say "expected '' to contain 'status:'" hides the reason. */
function runNode(args: string[], cwd: string): Run {
  try {
    const stdout = execFileSync("node", args, { cwd, stdio: "pipe" }).toString();
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number | null; stdout: Buffer; stderr: Buffer };
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
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

      // The bundle is COPIED OUT of the package before it is run, and this is
      // the whole test.
      //
      // Node resolves a bare specifier against the directory of the file that
      // imports it, never against `cwd`. Running `dist/octograph.mjs` in place
      // therefore proves nothing about self-containment: the file sits inside
      // `packages/graph/`, so `import … from "js-yaml"` resolves happily out
      // of `packages/graph/node_modules/` no matter what cwd is. Verified by
      // building with `external: ["js-yaml"]` — the emitted bundle kept two
      // live `from "js-yaml"` imports and still printed a clean report from a
      // temp-dir repo, i.e. the criterion this test exists for was unguarded
      // and a change that externalised a dependency would have shipped green.
      //
      // Under the OS temp dir there is no `node_modules` anywhere up the
      // chain, so any specifier esbuild left un-inlined fails to resolve and
      // node exits before printing anything.
      const isolated = join(mkdtempClean("octograph-bundle-"), "octograph.mjs");
      copyFileSync(BUNDLE_PATH, isolated);

      const repo = buildRepo(Array.from({ length: 3 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })));
      expect(existsSync(join(repo, "node_modules"))).toBe(false);

      const result = runNode([isolated, "doctor"], repo);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout).toContain("status:");
    },
    30_000,
  );
});
