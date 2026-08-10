import { execFileSync } from "node:child_process";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `node <args>` in `cwd` and return its exit code, stdout and stderr.
 *
 * One spelling, shared by every test that spawns the bundled CLI — the same
 * reason `buildRepo`/`mkdtempClean` live here rather than being re-typed per
 * file. `execFileSync` THROWS on a non-zero exit, and `doctor` legitimately
 * exits non-zero for a degraded or blocked report, so a caller that forgets
 * the try/catch reports a real, correct report as a crashed test.
 *
 * `stderr` is captured too, not discarded: the failure these tests exist to
 * catch (a dependency esbuild left un-inlined) shows up as an empty stdout and
 * an `ERR_MODULE_NOT_FOUND` on stderr, and an assertion that can only say
 * "expected '' to contain 'status:'" hides the reason.
 */
export function runNode(args: string[], cwd: string): Run {
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
