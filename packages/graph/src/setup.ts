import { runMapCommand } from "./cli.js";
import type { Config } from "./config.js";
import { doctor, exitCode as doctorExitCode, type Check, type Report } from "./doctor.js";

/**
 * Every effect `runSetup` can have on the outside world, injected — never
 * imported directly. `setup.ts` calls only through this port, so the whole
 * flow (doctor -> prompt -> install -> build -> postflight) is testable with
 * no TTY, no network, and no process spawned: a test hands it a port over
 * plain arrays instead. The real wiring — `node:readline` for `prompt`,
 * `node:child_process`'s `execFile` for `exec`, a `which`/`where` lookup for
 * `which` — lives in `setup-io.ts`, the ONE module allowed to import
 * `node:child_process` (`test/conventions.test.ts` enforces that).
 */
export interface SetupIO {
  /** Ask a yes/no question; resolves `true` only on an explicit yes. */
  prompt: (question: string) => Promise<boolean>;
  /** Write one line of progress/output. Never throws, never buffers. */
  log: (line: string) => void;
  /**
   * Run `file` with `args` as an argv array — NEVER a shell string, so there
   * is no string for an interpolated value to escape out of. Resolves, never
   * rejects: a failed spawn or a non-zero exit is a `code !== 0` result, not
   * a thrown error, so a caller cannot forget to catch it.
   */
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** The resolved absolute path to `file` on `PATH`, or `null` if it is not
   *  found — never throws. */
  which: (file: string) => Promise<string | null>;
}

/** The name of the graphify tool as it appears in `doctor()`'s report — the
 *  ONE check `runSetup` looks at to decide whether there is anything to
 *  offer installing. Every other check is printed but never acted on: `own`
 *  and `history depth` degrade the run, but there is nothing `setup` can
 *  install to fix either of them. */
const GRAPHIFY_CHECK = "graphify";

/** `uv tool install graphifyy` — the ONLY command `runSetup` ever runs, and
 *  the only reason `SetupIO.exec` exists at all. The double-`y` is correct:
 *  the published package is `graphifyy`, not the `Graphify-Labs/graphify`
 *  repo name. */
const INSTALL_ARGV: readonly [string, readonly string[]] = ["uv", ["tool", "install", "graphifyy"]];

function findCheck(report: Report, name: string): Check | undefined {
  return report.checks.find((c) => c.name === name);
}

/** One line per non-`ok` check, naming what is degraded and how to fix it by
 *  hand — reusing `Check.detail`/`Check.fix` verbatim rather than
 *  re-deriving the message doctor already computed. Printed unconditionally
 *  at the end of every run, consented install or not: a decline leaves the
 *  repo exactly as thin on this front as `octograph doctor` would already
 *  have reported, and this is where that gets said out loud one more time,
 *  next to what was just built. */
function postflight(report: Report): string {
  const degraded = report.checks.filter((c) => c.state !== "ok");
  if (degraded.length === 0) {
    return "octograph: setup complete — every check is ok.";
  }
  const lines = degraded.map((c) => {
    const fix = c.fix !== undefined ? ` — fix: ${c.fix}` : "";
    return `octograph: degraded — ${c.name}: ${c.detail}${fix}`;
  });
  return lines.join("\n");
}

/**
 * `octograph setup`: run doctor, prompt before installing anything, install
 * Graphify via `uv` on consent, build the map through the same pipeline
 * `octograph map` uses, and print a postflight naming anything still
 * degraded and how to fix it by hand.
 *
 * NOT a `runCli` command (see `cli.ts`'s `runCli`, and the mission plan this
 * implements): `runCli` is synchronous and never touches `process`,
 * precisely so an in-process caller (M6's VS Code commands) can run it
 * without spawning one — and prompting is unavoidably async. This is a
 * separate exported entry point instead.
 *
 * `now` is a required parameter, never read off the wall clock in here —
 * `analyze()`'s `AnalyzeOptions.now` (via `runMapCommand`) takes the same
 * requirement, and `test/conventions.test.ts` fails the build on a
 * `Date.now()` read anywhere under `src/`. The bin supplies `now` the exact
 * same way it supplies `runCli`'s.
 *
 * There is deliberately no way to skip the prompt: no `--yes`, no config
 * flag. A flag that skips it is the exact affordance this function's one
 * safety rule forbids.
 */
export async function runSetup(
  repoRoot: string,
  config: Config,
  now: number,
  io: SetupIO,
): Promise<number> {
  const report = doctor(repoRoot, config);

  const graphify = findCheck(report, GRAPHIFY_CHECK);
  if (graphify !== undefined && graphify.state === "missing") {
    const [file, args] = INSTALL_ARGV;
    const consent = await io.prompt(
      `octograph: Graphify is not installed. Install it now via \`uv tool install graphifyy\`? [y/N] `,
    );
    if (consent) {
      const result = await io.exec(file, [...args]);
      io.log(
        result.code === 0
          ? "octograph: Graphify installed."
          : `octograph: \`uv tool install graphifyy\` failed (exit ${result.code}).`,
      );
    } else {
      io.log("octograph: skipping Graphify install — continuing without it.");
    }
  }

  // The SAME pipeline `octograph map` runs — no second `analyze` /
  // `renderMap` / `writeArtifact` sequence in this file.
  const build = runMapCommand(repoRoot, config, undefined, now, false);
  if (build.stdout) io.log(build.stdout.trimEnd());
  if (build.stderr) io.log(build.stderr.trimEnd());

  io.log(postflight(report));

  return doctorExitCode(report);
}
