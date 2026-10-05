// Where this project's Claude Code transcripts live: ONE rule for the tokenomics pack scripts.
//
// collect.mjs reads its population from here and verify.mjs cross-checks ccusage against the same
// population, so both import this module rather than each spelling the rule. (The extension's TS
// twin, packages/tokenomics/src/claude-source.ts, is an intentional dual held to collect.mjs by
// claude-source-parity.test.ts.) Pure: no I/O, no side effects on import.
//
// Roots, in priority order (see README):
//   1. explicit: `--projects-dir DIR` or env OCTOBOTS_TOKENOMICS_PROJECTS_DIR
//   2. `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`
//   3. legacy repo-local `<main checkout>/.claude/projects` (read in ADDITION)
// Under each root only THIS project's slug directory belongs to it.

import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** `--project-dir DIR`, else $CLAUDE_PROJECT_DIR, else cwd; resolved so a relative path or a trailing slash cannot change the slug. */
export function resolveProjectDir(argv, env = process.env, cwd = process.cwd()) {
  const i = argv.indexOf("--project-dir");
  return resolve(i !== -1 ? argv[i + 1] : (env.CLAUDE_PROJECT_DIR ?? cwd));
}

/**
 * Transcripts are keyed by the MAIN checkout's path, never a worktree copy's (a worktree has no
 * transcript directory of its own), so `<main>/.claude/worktrees/<name>` unwinds to `<main>`.
 */
export function mainCheckoutDir(projectDir) {
  const wt = projectDir.indexOf("/.claude/worktrees/");
  return wt !== -1 ? projectDir.slice(0, wt) : projectDir;
}

/**
 * Claude Code names a project's transcript dir by replacing every character that is not
 * [A-Za-z0-9] in the absolute path with "-" ("/", "_" and "." included: `applied_ai` is stored as
 * `applied-ai`).
 */
export function projectSlug(mainDir) {
  return mainDir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The transcript roots, deduplicated, in priority order (module header). */
export function resolveRoots(mainDir, argv, env = process.env) {
  const i = argv.indexOf("--projects-dir");
  const explicit = (i !== -1 ? argv[i + 1] : null) || env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR;
  const roots = explicit
    ? [explicit]
    : [join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")];
  roots.push(join(mainDir, ".claude", "projects")); // legacy snapshot, read in addition
  return [...new Set(roots)];
}

/** Everything a script needs to locate this project's transcripts, from its own argv. */
export function locateTranscripts(argv, env = process.env, cwd = process.cwd()) {
  const projectDir = resolveProjectDir(argv, env, cwd);
  const mainDir = mainCheckoutDir(projectDir);
  return { projectDir, mainDir, slug: projectSlug(mainDir), roots: resolveRoots(mainDir, argv, env) };
}
