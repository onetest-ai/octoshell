import { formatDoctor, runMapCommand, runtimeError, type CliResult } from "./cli.js";
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

/**
 * uv's own documented install instructions — never astral.sh's raw
 * `install.sh`, which IS meant to be piped to a shell. Printing that URL
 * would be exactly the `curl … | sh` affordance this package's safety rules
 * exist to forbid; the docs page tells a human how to install it themselves,
 * on their own terms.
 */
const UV_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";

function findCheck(report: Report, name: string): Check | undefined {
  return report.checks.find((c) => c.name === name);
}

/**
 * What state this run LEFT BEHIND — every check, its own grade, and its
 * manual fix, rendered by `formatDoctor` (cli.ts), the same function
 * `octograph doctor` prints through. Never a second rendering of a check:
 * the first one here open-coded `octograph: degraded — <name>: <detail>` and
 * had already drifted from what `doctor` computes, stamping the report-level
 * word "degraded" onto optional checks (`board`) that by construction never
 * move `Report.status`.
 *
 * `report` is the report observed at the END of the run — see `runSetup`.
 * Printed on every path, consented install or not, and even after a build
 * that failed: the postflight is how a human tells what happened to their
 * machine, so the one run that must not skip it is the one that went wrong.
 */
function postflight(report: Report): string {
  return `octograph: setup finished — final state:\n${formatDoctor(report).trimEnd()}`;
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
 *
 * Every failure this flow can produce comes back as an exit code, not a
 * rejection — a repo `doctor` grades `blocked`, a declined install, a failed
 * install, and a build that throws are each reported and then returned. By
 * the time the build can fail, this function may already have changed the
 * user's machine; handing the caller an exception instead of a code loses
 * the postflight, which is the only record of what was done.
 */
export async function runSetup(
  repoRoot: string,
  config: Config,
  now: number,
  io: SetupIO,
): Promise<number> {
  const report = doctor(repoRoot, config);

  // `blocked` means the one required input is absent — no git history at all
  // — so there is nothing to build and nothing an install could fix.
  // Building anyway threw `git log`'s own error out of `analyze`, past this
  // function's `Promise<number>` contract, and past the postflight, while
  // `doctor` had already computed the exact diagnosis and its fix. Print
  // that instead, and touch nothing.
  if (report.status === "blocked") {
    io.log(postflight(report));
    return doctorExitCode(report);
  }

  // Whether this run ran a command that can change the machine — NOT whether
  // that command reported success. A failed `uv tool install` can still have
  // left something behind, so either way the state reported at the end has
  // to be re-observed rather than remembered.
  let mutated = false;

  // Whether this run wanted to install Graphify and COULD NOT, because `uv`
  // itself is not on `PATH`. Distinct from an explicit decline: declining is
  // a choice a healthy repo can still exit 0 on (see the exit-code
  // computation below), but an absent `uv` means the run could not do what
  // it set out to do — that is reported with a non-zero exit even though
  // `graphify` is only an optional check and never moves `Report.status`.
  let uvMissing = false;

  const graphify = findCheck(report, GRAPHIFY_CHECK);
  if (graphify !== undefined && graphify.state === "missing") {
    const [file, args] = INSTALL_ARGV;
    // Checked BEFORE prompting: there is nothing to ask consent for if the
    // install command itself cannot run. Piping astral.sh's `install.sh` to
    // a shell as a fallback would "fix" this transparently — and is exactly
    // the affordance this package's safety rules forbid, so the fix is
    // handed back to the human instead.
    const uvPath = await io.which(file);
    if (uvPath === null) {
      uvMissing = true;
      io.log(
        `octograph: \`uv\` not found on PATH — install it yourself from ${UV_INSTALL_URL}, ` +
          `then re-run \`octograph setup\` to install Graphify.`,
      );
    } else {
      const consent = await io.prompt(
        `octograph: Graphify is not installed. Install it now via \`uv tool install graphifyy\`? [y/N] `,
      );
      if (consent) {
        const result = await io.exec(file, [...args]);
        mutated = true;
        io.log(
          result.code === 0
            ? "octograph: `uv tool install graphifyy` succeeded."
            : `octograph: \`uv tool install graphifyy\` failed (exit ${result.code}).`,
        );
      } else {
        io.log("octograph: skipping Graphify install — continuing without it.");
      }
    }
  }

  // The SAME pipeline `octograph map` runs — no second `analyze` /
  // `renderMap` / `writeArtifact` sequence in this file. Caught here because
  // this call sits OUTSIDE `runCli`'s try/catch, through the same
  // `runtimeError` spelling that one uses.
  let build: CliResult;
  try {
    build = runMapCommand(repoRoot, config, undefined, now, false);
  } catch (err) {
    build = runtimeError(err);
  }
  if (build.stdout) io.log(build.stdout.trimEnd());
  if (build.stderr) io.log(build.stderr.trimEnd());

  // Re-observed, never replayed: once this run has installed something, the
  // report `doctor` produced BEFORE the install describes a machine that no
  // longer exists. Replaying it printed "`uv tool install graphifyy`
  // succeeded" and, three lines later, "graphify: not installed — fix: uv
  // tool install graphifyy" — a postflight contradicting its own run and
  // telling a human to re-run the command that had just worked. A postflight
  // that reports a state it did not verify is this campaign's one recurring
  // defect; the second `doctor()` call is what makes this one a report
  // rather than a memory. Skipped entirely when nothing was installed, where
  // the first report is still a true observation.
  const finalReport = mutated ? doctor(repoRoot, config) : report;
  io.log(postflight(finalReport));

  // A failed build is a failed `setup`, whatever the checks say about the
  // repo: the artifact this run claims to have written is the thing it was
  // asked to produce. An absent `uv` is reported next: `graphify` is an
  // optional check that never moves `Report.status`, so `doctorExitCode`
  // alone would return 0 on an otherwise-healthy repo even though this run
  // could not do what it set out to do.
  if (build.code !== 0) return build.code;
  if (uvMissing) return 1;
  return doctorExitCode(finalReport);
}
