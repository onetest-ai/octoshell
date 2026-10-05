/**
 * Vitest setup file: every git process this suite spawns — fixture builders,
 * inline `execFileSync("git", ...)` calls, and the git calls the CLI under
 * test makes in its own child — runs with background maintenance disabled.
 *
 * Why (M4 B1): every `git commit` ends by launching
 * `git maintenance run --auto --quiet --detach`. That child daemonizes
 * IMMEDIATELY, before it decides whether any task is due, and then takes
 * `.git/objects/maintenance.lock` and may touch `gc.log`. It is not our
 * child to await, so a fixture's `rmSync(.git)` can race it and fail with
 * ENOTEMPTY — on a slow CI runner, long after the test's own assertions
 * passed. (Observed with GIT_TRACE2_EVENT: one detached maintenance process
 * per commit, ~40 per fixture.) Turning the trigger off is the cure; the
 * retry in `tmpdir.ts` is only the backstop.
 *
 * Done through `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` so it reaches every git
 * invocation regardless of who spawns it, without editing each repo's config.
 */
export const GIT_HYGIENE_CONFIG = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["core.fsmonitor", "false"],
] as const;

GIT_HYGIENE_CONFIG.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});
process.env.GIT_CONFIG_COUNT = String(GIT_HYGIENE_CONFIG.length);
