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
import { runCli } from "../src/cli.js";

const result = runCli(process.argv.slice(2), process.cwd(), Date.now());
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.code);
