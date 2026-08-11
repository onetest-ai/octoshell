// The ONE module in this package allowed to import `node:child_process` —
// enforced by `test/conventions.test.ts`. Every other module reaches the
// outside world only through the `SetupIO` port `setup.ts` defines, so this
// is also the only module that can spawn a process at all, and the only one
// a review of "does this ever pipe a remote script to a shell" needs to read.
//
// `execFile`, never `exec` or `spawn({ shell: true })`: an argv array leaves
// no string for an interpolated value to escape out of. This file is the
// safety-critical surface `setup.ts`'s own tests replace with a fake — see
// `test/setup-io.test.ts`, which exercises this wiring directly rather than
// only type-checking it.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { SetupIO } from "./setup.js";

const execFileAsync = promisify(execFile);

interface ExecError {
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null;
}

/**
 * Run `file` with `args` as an argv array — never a shell string — and
 * never throw: a failed spawn (command not found) or a non-zero exit both
 * come back as `{ code, stdout, stderr }`, so a caller cannot forget to
 * catch what this does.
 */
async function exec(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (!isExecError(err)) return { code: 1, stdout: "", stderr: String(err) };
    const code = typeof err.code === "number" ? err.code : 1;
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : typeof err.message === "string"
          ? err.message
          : "";
    return { code, stdout, stderr };
  }
}

/** `file`'s resolved location on `PATH`, or `null` if it is not found —
 *  through the same `exec` above (`which`/`where`, an argv array, never a
 *  shell), not a second spawning primitive. */
async function which(file: string): Promise<string | null> {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = await exec(lookup, [file]);
  if (result.code !== 0) return null;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first ?? null;
}

/** A y/N prompt over a real TTY (`node:readline`), resolving `true` only on
 *  an explicit yes — anything else, including a bare Enter, is a no. */
function prompt(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
}

function log(line: string): void {
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

/** The real `SetupIO`, wired to an actual TTY and an actual process table —
 *  what `bin/octograph.mjs` hands `runSetup` for a real `octograph setup`
 *  invocation. Every test in this package's suite except
 *  `test/setup-io.test.ts` replaces this with a fake over plain arrays. */
export const realSetupIO: SetupIO = { prompt, log, exec, which };
