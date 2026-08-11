import { describe, expect, it, vi } from "vitest";
import { execFile, exec as childExec, spawn as childSpawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

/**
 * `node:child_process` mocked so this test can see WHICH primitive
 * `setup-io.ts` actually calls, while every call still runs the real thing
 * (`vi.fn(actual.execFile)` calls through) — the "harmless real binary" the
 * plan asks for is genuinely spawned, not stubbed out.
 *
 * Real `execFile` carries a `util.promisify.custom` implementation that
 * resolves `{ stdout, stderr }` — but Node's own version reaches into the
 * real implementation directly, bypassing whatever `execFile` a caller
 * promisified. Copying THAT onto the mock would make `setup-io.ts`'s
 * `promisify(execFile)` call the real primitive under the mock's back,
 * defeating the spy silently (the call still succeeds; `execFileSpy` just
 * never sees it). This custom implementation instead calls the MOCK ITSELF
 * with a callback, so a call through `promisify()` is both tracked and
 * correct.
 *
 * It forwards EVERY argument it was given, not just `(file, args)`. A
 * two-parameter version silently dropped a third — which is precisely the
 * `{ shell: true }` options object the "never spawn through a shell" rule
 * exists to forbid, and it would never have reached `execFileSpy` for the
 * guard below to see. A spy that cannot observe the dangerous argument is
 * not a guard.
 */
vi.mock("node:child_process", async (importOriginal) => {
  const util = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileMock = vi.fn(actual.execFile) as unknown as typeof actual.execFile;
  const callMock = execFileMock as unknown as (...args: unknown[]) => unknown;
  Object.defineProperty(execFileMock, util.promisify.custom, {
    value: (...callArgs: unknown[]) =>
      new Promise((resolve, reject) => {
        callMock(...callArgs, (err: unknown, stdout: unknown, stderr: unknown) => {
          if (err) {
            (err as Record<string, unknown>).stdout = stdout;
            (err as Record<string, unknown>).stderr = stderr;
            reject(err);
            return;
          }
          resolve({ stdout, stderr });
        });
      }),
  });
  return {
    ...actual,
    execFile: execFileMock,
    exec: vi.fn(actual.exec),
    spawn: vi.fn(actual.spawn),
  };
});

// Imported AFTER the mock is declared (vi.mock is hoisted above every
// import in this file), so `realSetupIO` is built against the mocked
// `node:child_process` above.
const { realSetupIO } = await import("../src/setup-io.js");

const execFileSpy = vi.mocked(execFile);
const execSpy = vi.mocked(childExec);
const spawnSpy = vi.mocked(childSpawn);

/**
 * The safety-critical module every other test in this suite replaces with a
 * fake (see `test/setup.test.ts`). Without a direct test the real
 * `execFile`/`readline`/`which` wiring is never exercised anywhere — this
 * file is that exercise.
 *
 * `process.execPath` — the running `node` binary itself, an absolute path —
 * is the "harmless real binary" the plan asks for: never `uv`, and no PATH
 * lookup ambiguity across platforms.
 */
describe("setup-io — the real SetupIO", () => {
  it("exec() reaches execFile, and never exec()/spawn(), for a real process", async () => {
    const result = await realSetupIO.exec(process.execPath, ["--version"]);

    // The promisified result shape actually works — not just type-checked.
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+/);

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(execFileSpy.mock.calls[0]?.[1]).toEqual(["--version"]);
    expect(execSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("exec() never throws for a command that fails to spawn — it reports a non-zero code instead", async () => {
    const result = await realSetupIO.exec("octograph-definitely-not-a-real-binary-xyz", []);
    expect(result.code).not.toBe(0);
  });

  it("exec() never throws for a real process that exits non-zero", async () => {
    // `node -e "process.exit(3)"` — a real spawn, a real non-zero exit, no
    // shell string involved.
    const result = await realSetupIO.exec(process.execPath, ["-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });

  it("which() resolves null for a binary that does not exist on PATH", async () => {
    const found = await realSetupIO.which("octograph-definitely-not-a-real-binary-xyz");
    expect(found).toBeNull();
  });

  it("which() reaches execFile too, never exec()/spawn()", async () => {
    execFileSpy.mockClear();
    execSpy.mockClear();
    spawnSpy.mockClear();

    await realSetupIO.which("octograph-definitely-not-a-real-binary-xyz");

    expect(execFileSpy).toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  /**
   * "Never `exec`/`spawn`" is not the whole rule — `execFile(file, args, {
   * shell: true })` runs the argv through `/bin/sh` too, and the two
   * assertions above pass for it unchanged. That is the one edit a
   * well-meaning future maintainer actually makes here ("Windows can't find
   * `uv` without a shell"), so it is the one this guard has to catch: NO
   * options object reaching `execFile` may carry `shell`, on either call
   * path.
   */
  it("never passes a shell option to execFile — on either call path", async () => {
    execFileSpy.mockClear();

    await realSetupIO.exec(process.execPath, ["--version"]);
    await realSetupIO.which("octograph-definitely-not-a-real-binary-xyz");

    expect(execFileSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of execFileSpy.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
          expect(arg).not.toHaveProperty("shell");
        }
      }
    }
  });
});

/**
 * The `readline` half of the port, exercised against real streams — the
 * plan's whole reason for testing this module directly is that no other test
 * in the package ever runs this code, and a prompt is what stands between a
 * user and a tool install.
 *
 * `process.stdin`/`process.stdout` are swapped for plain streams rather than
 * faked at the `readline` layer, so the wiring under test is the wiring that
 * ships.
 */
async function promptWith(input: Readable): Promise<{ answer: boolean; asked: string }> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const answer = await realSetupIO.prompt("install? [y/N] ");
    return { answer, asked: written.join("") };
  } finally {
    if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
    if (stdoutDescriptor) Object.defineProperty(process, "stdout", stdoutDescriptor);
  }
}

describe("setup-io — prompt", () => {
  it("asks the question and resolves true only on an explicit yes", async () => {
    const { answer, asked } = await promptWith(Readable.from(["y\n"]));
    expect(asked).toContain("install?");
    expect(answer).toBe(true);
  });

  it("treats a bare Enter as a no", async () => {
    const { answer } = await promptWith(Readable.from(["\n"]));
    expect(answer).toBe(false);
  });

  /**
   * stdin at EOF with nothing typed — `octograph setup < /dev/null`, a CI
   * runner, a closed pipe, an M6 terminal whose input is not attached.
   * `readline`'s `question` callback NEVER fires on that path, so a prompt
   * that only listens for an answer hangs forever with the interface still
   * open, having printed a question nobody can answer. Declining is the only
   * safe resolution for a prompt that guards an install.
   *
   * The timeout is the assertion: a regression here does not fail loudly, it
   * hangs.
   */
  it("declines, rather than hanging, when stdin closes with no answer", { timeout: 10_000 }, async () => {
    const { answer } = await promptWith(Readable.from([]));
    expect(answer).toBe(false);
  });
});
