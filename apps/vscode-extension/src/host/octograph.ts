/**
 * octograph's thin-launcher command construction — pure functions only, no `vscode` import (see
 * `test/octograph.test.ts`'s "imports vscode nowhere" guard, which is what keeps this true rather
 * than a comment nobody re-checks). The glue that creates a terminal and sends what `graphCommand`
 * builds is a SEPARATE, not-yet-written module (M6's next task, planned as `octograph-command.ts`
 * — no such file exists yet, and this comment is a forward reference, not a description of one);
 * this module never touches the VS Code API, so it stays unit-testable without a running
 * extension host.
 *
 * TWO validators, deliberately, because the arguments this module handles are not the same
 * shape:
 *
 *  - **Task ids** (`conflicts <a> <b>`) — a safe-slug charset, the same shape
 *    `sdlc-bundles.ts`'s `SAFE_BUNDLE_ID` already uses for a discovered bundle directory name.
 *  - **Paths** (`impact <path>`) — a slug validator is the WRONG tool here: real paths carry
 *    `/`, `.`, `-`, and sometimes spaces, and loosening the slug charset to admit them would
 *    quietly gut the injection guard it exists to provide (a slug that also matches every path
 *    validates almost anything). `impactArgv` instead resolves the path, asserts it stays inside
 *    the workspace root, rejects shell metacharacters outright, and returns it as its own argv
 *    element — never interpolated into a command string, so it needs no quoting at all.
 *
 * Neither validator is reachable from the other's call site: `conflictsArgv` never resolves a
 * filesystem path, and `impactArgv` never runs the slug charset. Keeping them as two distinct,
 * non-overlapping functions is the point of this module's design, not an incidental detail.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { GRAPH_RELATIVE_PATH } from "./octograph-install.js";

/** Build the documented bare-`node` invocation for a launcher command. No `npx`, no network. */
export function graphCommand(cmd: "setup" | "map"): string {
  return `node ${GRAPH_RELATIVE_PATH} ${cmd}`;
}

/**
 * `.octobots/graph` when the workspace has a board, `.octograph` otherwise.
 *
 * Mirrors TWO of `packages/graph/src/artifact.ts`'s `resolveOut` THREE branches — its
 * `hasBoard(repoRoot)` split, whose `.octobots` existence check is the one place the graph package
 * itself asks the question. This is a plain read, never a write: it never creates `.octobots/` in
 * a workspace that has none.
 *
 * **It does NOT cover `resolveOut`'s first branch**, and a caller must not read it as "where the
 * run wrote". `resolveOut` returns `resolve(repoRoot, config.out)` when `octograph.yaml` sets a
 * containment-clean `out:`, and that wins over BOTH branches below. Honouring it here would mean a
 * third spelling of `loadConfig`'s YAML read and of the containment check `out` is validated
 * with — the extension cannot import either (mission criterion 4) — so this deliberately stays the
 * default-location answer and says so rather than claiming agreement it cannot deliver. A consumer
 * that must show the user where the artifact actually landed should read the path back from the
 * run, not compute it here; `test/octograph.test.ts` pins this gap so it stays visible.
 */
export function artifactPath(repoRoot: string): string {
  return existsSync(join(repoRoot, ".octobots"))
    ? join(repoRoot, ".octobots", "graph")
    : join(repoRoot, ".octograph");
}

// ---------------------------------------------------------------------------------------------
// Path containment — a hand-duplicated TWIN of packages/graph/src/paths.ts's `insideRepo`.
// ---------------------------------------------------------------------------------------------

/**
 * `fs.realpathSync`, returning `null` for a path that does not exist (or is otherwise unreadable)
 * rather than throwing. Copied verbatim from `packages/graph/src/paths.ts`'s helper of the same
 * name and purpose — see that file for the full rationale.
 */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolve `path` following symlinks as far as an existing ancestor allows, re-appending whatever
 * suffix does not exist on disk. Copied from `packages/graph/src/paths.ts`'s function of the same
 * name — see that file's doc comment for why a plain `realpathSync` on the whole candidate is not
 * enough (it throws `ENOENT` for a path naming a file that legitimately does not exist yet, and a
 * fallback to the unresolved string would silently reopen the symlink-escape hole this exists to
 * close) and why walking upward to the deepest EXISTING ancestor is exact rather than a heuristic.
 */
function resolveAsFarAsExists(path: string): string {
  const tail: string[] = [];
  let dir = path;
  for (;;) {
    const real = tryRealpath(dir);
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(dir);
    if (parent === dir) return path; // filesystem root itself did not resolve — give up cleanly
    tail.unshift(basename(dir));
    dir = parent;
  }
}

/**
 * `resolvedRoot` from `packages/graph/src/paths.ts`, copied: resolve the workspace root through
 * the same realpath'd namespace the candidate is compared against, falling back to the
 * unresolved value only if the root itself does not exist (it is expected to — this is the open
 * workspace).
 */
function resolvedWorkspaceRoot(repoRoot: string): string {
  const root = resolve(repoRoot);
  return tryRealpath(root) ?? root;
}

/**
 * THE SECOND SPELLING of `packages/graph/src/paths.ts`'s `insideRepo` containment rule.
 *
 * This module cannot import that function — `@octoshell/graph` is not a runtime dependency of
 * the extension (mission criterion 4), and the one devDependency edge this mission's Task 1 might
 * have added would have been for build ordering only, not for reuse here. So this is a
 * hand-duplicated TWIN, not an independent design: it exists because `insideRepo` cannot be
 * reached from here, and it is pinned to that fact by this comment rather than left to silently
 * drift the way an unlabelled copy would.
 *
 * Naive `resolve(root, path).startsWith(root)` STRING MATH is not enough, for exactly the reason
 * `insideRepo`'s own doc comment gives: a symlink placed INSIDE the workspace that points OUTSIDE
 * it passes that check (the string itself never leaves the root) and is only followed later,
 * unguarded, by whatever eventually reads the file. So both the root and the candidate are
 * resolved through `realpathSync` (via `resolveAsFarAsExists`, which handles a candidate that
 * does not fully exist on disk) before comparing — the same fix `insideRepo` applies, for the
 * same threat: `path` here is caller-supplied (VS Code command input, or a future CLI-driven
 * call), not trusted structure.
 *
 * `ESCAPE_VECTORS` in `test/octograph.test.ts` names the forms this is tested against, and each
 * entry's id must match an `// escape-vector: <id>` marker on the corresponding case in
 * `packages/graph/test/paths.test.ts`. That equality is ENFORCED by the "escape-vector lists
 * agree" test, in both directions — not asserted by this comment. There is no shared import to
 * keep the two halves aligned, so a test does it: adding a vector on one side only is a red test,
 * which is exactly how the original divergence here was found (`absolute-elsewhere` was tested
 * only on the extension side while three comments claimed both suites covered it).
 *
 * Returns the resolved, realpath'd absolute path when `path` is inside the workspace, or `null`
 * when it escapes.
 */
function insideWorkspace(repoRoot: string, path: string): string | null {
  const root = resolvedWorkspaceRoot(repoRoot);
  const abs = resolve(root, path);
  const candidate = resolveAsFarAsExists(abs);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

/**
 * Characters that carry special meaning to a shell, rejected OUTRIGHT rather than escaped or
 * quoted — `impactArgv`'s path becomes its own `argv` element (never interpolated into a command
 * string), so quoting is not just unnecessary but the wrong instinct: a caller who quotes a
 * rejected character is still one `sendText` string-join away from reintroducing the very
 * injection this guard exists to prevent. A legitimate path with a space or a dot is unaffected —
 * neither is in this set.
 *
 * `\` IS in this set, which on Windows also rejects a native separator: a caller there must pass
 * the forward-slash spelling (`Uri.fsPath` is backslash-separated — `asRelativePath` or a manual
 * `split(sep).join("/")` is what to hand this function). Deliberate: `\` is the shell escape
 * character, and admitting it to spare Windows callers a conversion would reopen the hole this set
 * exists to close. Stated here because the first Windows consumer will otherwise read a blanket
 * rejection as a bug.
 */
const SHELL_METACHARACTERS = /[;&|`$()<>\n\r"'\\*?~#!{}[\]]/;

/**
 * A safe task-id slug: lowercase, digits, single hyphens between segments. The same shape
 * `sdlc-bundles.ts`'s `SAFE_BUNDLE_ID` validates a discovered bundle directory name against — not
 * imported (that constant is private to that module and the two ids come from unrelated
 * sources), but the same charset for the same reason: a task id becomes an `argv` element in an
 * auto-run terminal command, so anything outside this shape is rejected rather than passed
 * through.
 *
 * Deliberately far narrower than {@link insideWorkspace}'s path check: a task id never contains
 * `/`, `.`, or a space, so this validator does not accept — and never resolves, never
 * containment-checks — anything that looks like a path. `conflictsArgv` and `impactArgv` do not
 * call into each other's validator.
 */
const SAFE_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Build the argv for `octograph impact <path>`, or `null` if `path` is rejected.
 *
 * Rejected when `path` escapes the workspace root (see {@link insideWorkspace} — a `..`
 * traversal, an absolute path elsewhere, or a symlink whose real target escapes) or contains a
 * shell metacharacter (see {@link SHELL_METACHARACTERS}). Otherwise `path` is returned VERBATIM,
 * as its own `argv` element — no quoting, no escaping, no resolution to an absolute filesystem
 * path that would leak the local checkout location into a terminal command shown to the user.
 *
 * No consumer in this mission (T6.2's scope is command construction, not wiring a VS Code
 * command to it) — the intended consumer is a future `Octobots: Impact` command. Whoever writes
 * it: `vscode.Terminal.sendText` takes a single STRING, not an argv array — only
 * `TerminalShellIntegration.executeCommand` accepts argv, and it falls back to `sendText`
 * (string-joining, with all the quoting this module deliberately avoided) when shell integration
 * is not active. This argv array is not automatically safe to hand to `sendText`; that seam is
 * the next mission's problem, not solved here.
 */
export function impactArgv(repoRoot: string, path: string): string[] | null {
  // Blank first: `resolve(root, "")` IS the root, so containment alone accepts an empty path and
  // would put an empty string in the argv — a value no caller means, and one that vanishes
  // entirely in any downstream string-join (`sendText`, a shell history entry), turning
  // `impact <path>` into a different command than the one that was validated.
  if (path.trim() === "") return null;
  if (SHELL_METACHARACTERS.test(path)) return null;
  if (insideWorkspace(repoRoot, path) === null) return null;
  return ["node", GRAPH_RELATIVE_PATH, "impact", path];
}

/**
 * Build the argv for `octograph conflicts <id> [<id> ...]`, or `null` if any id is rejected.
 *
 * Every id is checked against {@link SAFE_TASK_ID} — never against {@link insideWorkspace}, which
 * is a path check and has no meaning for a task id. An empty list is also rejected: the CLI
 * itself requires at least one id, and there is nothing to build a command from otherwise.
 *
 * No consumer in this mission — see {@link impactArgv}'s doc comment for the `sendText`
 * caveat, which applies here identically.
 */
export function conflictsArgv(ids: string[]): string[] | null {
  if (ids.length === 0) return null;
  if (!ids.every((id) => SAFE_TASK_ID.test(id))) return null;
  return ["node", GRAPH_RELATIVE_PATH, "conflicts", ...ids];
}
