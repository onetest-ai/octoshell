/**
 * The Octobots status line: a `statusLine` command entry in the workspace's `.claude/settings.json`,
 * backed by a script the pack ships.
 *
 * PROJECT-LOCAL BY DESIGN. The script installs to `<repo>/.octobots/statusline.sh` and is registered
 * through `${CLAUDE_PROJECT_DIR}`, never an absolute path — the same rule the hooks follow. A
 * system-wide `~/.claude/statusline.sh` works until you open a second project, at which point one
 * repo's copy is silently deciding what every other repo renders; worse, an absolute path baked into
 * settings breaks outright on another machine or a fresh clone.
 *
 * NEVER CLOBBERS A FOREIGN STATUS LINE. `statusLine` holds exactly one entry, so registering ours
 * over somebody else's would delete a configuration we did not write and cannot restore. We adopt
 * the slot only when it is empty or already ours; anything else is reported and left alone.
 */

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePackVersionMarker } from "./pack-version-marker.js";

/** Relative to the repo root — the installed script and the token the registration must contain. */
const SCRIPT_REL = ".octobots/statusline.sh";
/** What we write into settings. `${CLAUDE_PROJECT_DIR}` keeps it portable across machines/clones. */
const STATUSLINE_CMD = `bash "\${CLAUDE_PROJECT_DIR}/${SCRIPT_REL}"`;

type StatusLine = { type?: string; command?: string };

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err; // malformed JSON — do not silently discard the user's settings
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Copy the pack's statusline script into <repo>/.octobots. Returns files written. */
export function installStatusline(srcRoot: string, repoRoot: string): number {
  const from = join(srcRoot, "statusline", "statusline.sh");
  if (!existsSync(from)) return 0;
  const to = join(repoRoot, SCRIPT_REL);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755); // it is invoked as `bash <path>`, but keep it executable for direct runs
  return 1;
}

/** True when this settings entry is the one we install (by the script it runs). */
function isOurs(sl: StatusLine | undefined): boolean {
  return typeof sl?.command === "string" && sl.command.includes(SCRIPT_REL);
}

/**
 * Register our status line in <repo>/.claude/settings.json.
 *
 * Returns what happened, because "somebody else owns this slot" is a legitimate outcome the caller
 * must be able to report rather than a failure to swallow:
 *   - `registered` — the slot was empty or already ours
 *   - `foreign`    — a different status line is configured; we changed nothing
 */
export function registerStatusline(repoRoot: string): "registered" | "foreign" {
  const path = join(repoRoot, ".claude", "settings.json");
  const settings = readJson(path);
  const existing = settings.statusLine as StatusLine | undefined;
  if (existing?.command !== undefined && !isOurs(existing)) return "foreign";
  settings.statusLine = { type: "command", command: STATUSLINE_CMD };
  writeJson(path, settings);
  return "registered";
}

/** Remove our status line, leaving a foreign one untouched. Returns true when something was removed. */
export function unregisterStatusline(repoRoot: string): boolean {
  const path = join(repoRoot, ".claude", "settings.json");
  const settings = readJson(path);
  if (!isOurs(settings.statusLine as StatusLine | undefined)) return false;
  delete settings.statusLine;
  writeJson(path, settings);
  return true;
}

export interface StatuslineStatus {
  /** The script exists on disk. */
  scriptPresent: boolean;
  /** `.claude/settings.json` points at it. */
  registered: boolean;
  /** A DIFFERENT status line owns the slot — we must not overwrite it. */
  foreign: boolean;
  /** Version marker in the installed script; null when absent/unreadable. */
  version: number | null;
  /** Script present, registered, and at `expected`. */
  current: boolean;
}

/** Inspect the installed status line without changing anything. */
export function statuslineStatus(repoRoot: string, expected: number): StatuslineStatus {
  const scriptPath = join(repoRoot, SCRIPT_REL);
  const scriptPresent = existsSync(scriptPath);
  let version: number | null = null;
  if (scriptPresent) {
    try { version = parsePackVersionMarker(readFileSync(scriptPath, "utf8")); } catch { version = null; }
  }
  let sl: StatusLine | undefined;
  try { sl = readJson(join(repoRoot, ".claude", "settings.json")).statusLine as StatusLine | undefined; }
  catch { sl = undefined; } // malformed settings — treat as unregistered, doctor reports the parse
  const registered = isOurs(sl);
  const foreign = sl?.command !== undefined && !registered;
  return { scriptPresent, registered, foreign, version, current: scriptPresent && registered && version === expected };
}
