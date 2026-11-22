// Where the tokenomics work log lives: ONE rule, shared by set-status.js (which writes the line itself)
// and the work-log.mjs hook (its de-duplicated fallback), so one flip can never land in two files.
//
// The rule is the hook's: the SESSION's project dir (CLAUDE_PROJECT_DIR, then OCTOBOTS_PROJECT_DIR, then
// the cwd), not the checkout the board path happens to sit in. In a git worktree the two differ. The
// session's project dir is the one the hooks, the dedupe and the tokenomics collect/rollup all read, so
// that is where the log must be; the board path only says which entity moved, not whose log it is.
import { join, resolve } from "node:path";

/** The project root a session's hooks and tokenomics run against. */
export function worklogProjectDir(env = process.env, cwd = process.cwd()) {
  return resolve(env.CLAUDE_PROJECT_DIR ?? env.OCTOBOTS_PROJECT_DIR ?? cwd);
}

/** `<project>/.octobots/tokenomics/worklog.jsonl` for the session's project dir. */
export function worklogFile(env = process.env, cwd = process.cwd()) {
  return join(worklogProjectDir(env, cwd), ".octobots", "tokenomics", "worklog.jsonl");
}
