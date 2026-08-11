import { describe, expect, it, vi } from "vitest";
import { execFile, exec as childExec, spawn as childSpawn } from "node:child_process";

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
 */
vi.mock("node:child_process", async (importOriginal) => {
  const util = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileMock = vi.fn(actual.execFile) as unknown as typeof actual.execFile & {
    (file: string, args: string[], cb: (err: unknown, stdout: unknown, stderr: unknown) => void): unknown;
  };
  Object.defineProperty(execFileMock, util.promisify.custom, {
    value: (file: string, args: string[]) =>
      new Promise((resolve, reject) => {
        execFileMock(file, args, (err, stdout, stderr) => {
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
});
