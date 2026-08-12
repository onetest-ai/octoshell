#!/usr/bin/env node
// The one place this package reads the wall clock or talks to the process —
// deliberately outside `src/`, which `test/conventions.test.ts` scans for a
// `Date.now()`/`Math.random()` read in "graph computation" and fails the
// build on. Everything with actual logic (flag parsing, dispatch, output
// formatting) lives in `../src/cli.ts`, tested directly and without a
// process to spawn; this file is wiring only, on purpose — the anti-pattern
// this package exists to avoid is a *second, hand-written implementation*
// beside the real one (see `tokenomics`'s 838-line `rollup.mjs` next to its
// 309-line `rollup.ts`), not a thin bootstrap that calls straight into it.
//
// `setup` is routed separately from every other command, on purpose: it is
// NOT a `runCli` command (see `../src/setup.ts`'s doc comment) — `runCli` is
// synchronous and never touches `process`, precisely so an in-process caller
// (M6) can run it without spawning one, and prompting before an install is
// unavoidably async. This is the one place `../src/setup-io.ts`'s real
// `SetupIO` — an actual TTY, an actual process table — gets constructed and
// handed to `runSetup`; every test in this package's suite hands it a fake
// instead.
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { realSetupIO } from "../src/setup-io.js";
import { runSetup } from "../src/setup.js";

const argv = process.argv.slice(2);

if (argv[0] === "setup") {
  if (argv.length > 1) {
    process.stderr.write("octograph: setup takes no arguments\n");
    process.exit(2);
  }
  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);
  const code = await runSetup(repoRoot, config, Date.now(), realSetupIO);
  process.exit(code);
} else {
  const result = runCli(argv, process.cwd(), Date.now());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
