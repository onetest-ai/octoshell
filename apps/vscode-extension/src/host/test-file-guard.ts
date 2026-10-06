// The path guard behind every webview-supplied test-case path: VS Code free (board-host.ts uses it, and must not
// import vscode), re-exported from campaigns-tree.ts so its callers and open-test-file-webview.test.ts are unchanged.
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const inside = (root: string, p: string): string | null => {
  const rel = relative(root, p);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
};

/**
 * The file {@link OPEN_TEST_FILE_COMMAND} may open: an existing `TC-*.md` under `<board>/campaigns/<c>/tests/`,
 * after resolving `..` and symlinks, or null (no argument, a non-string, another file, a path that leaves the
 * board). The command is callable by anything that can run a command, so its argument is never trusted.
 */
export function testFileToOpen(boardRoot: string, arg: unknown): string | null {
  if (typeof arg !== "string" || arg.length === 0) return null;
  const abs = resolve(arg);
  if (!existsSync(abs) || !existsSync(boardRoot)) return null;
  const rel = inside(realpathSync(boardRoot), realpathSync(abs));
  if (!rel || inside(resolve(boardRoot), abs) === null) return null;
  const parts = rel.split(sep);
  return parts.length >= 4 && parts[0] === "campaigns" && parts[2] === "tests" && /^TC-[^\\/]*\.md$/.test(parts[parts.length - 1]!)
    ? abs
    : null;
}

/**
 * The {@link OPEN_TEST_FILE_COMMAND} argument for a webview `openTestFile` message: its board-relative path
 * (TestCase.path) joined under the board. Still untrusted: the command runs {@link testFileToOpen} on it, so a
 * crafted `../` path or an absolute one never opens anything outside the board's tests folders.
 */
export const testFileArgFromWebview = (boardRoot: string, boardRelPath: string): string => join(boardRoot, boardRelPath);

/**
 * The absolute path of a TC's evidence file, or null. `evidence` is the repo-relative path a TC's `last_run.evidence`
 * records (read by the HOST from the TC on disk, never taken from the webview); `repoRoot` is the workspace folder
 * (the board root's parent). It resolves, after `..` and symlinks, to a REGULAR file inside the workspace folder, or
 * nothing opens: a missing file, a directory, an absolute or `..` path and a link leaving the workspace are all null.
 */
export function evidenceFileToOpen(repoRoot: string, evidence: unknown): string | null {
  if (typeof evidence !== "string" || evidence.length === 0 || evidence.includes("\0") || isAbsolute(evidence)) return null;
  try {
    const abs = resolve(repoRoot, evidence);
    if (inside(resolve(repoRoot), abs) === null) return null;
    const real = realpathSync(abs);
    if (inside(realpathSync(repoRoot), real) === null) return null;
    return statSync(real).isFile() ? abs : null;
  } catch {
    return null;
  }
}
