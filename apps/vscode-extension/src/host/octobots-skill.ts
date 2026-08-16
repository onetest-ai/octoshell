import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installPrimer, registerClaudeHook, unregisterClaudeHook, claudeHookStatus } from "./octobots-hooks.js";
import { installTokenomics, tokenomicsStatus } from "./octobots-tokenomics.js";
import { installGraph, graphStatus } from "./octograph-install.js";
import { installStatusline, registerStatusline, unregisterStatusline, statuslineStatus } from "./octobots-statusline.js";
import { installTools, removeTools, toolsStatus } from "./octobots-tools.js";
import { parsePackVersionMarker } from "./pack-version-marker.js";

/** Bump when the skill or either agent payload changes; covers the pack as one unit. */
export const OCTOBOTS_PACK_VERSION = 56;

/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "workflow-designer", "mission-execution", "mission-completion-gate", "knowledge-explorer"] as const;

/**
 * Skill dirs earlier pack versions installed that no longer exist. Removed on install so an
 * agent never sees a renamed skill twice (v18's `octobots` is now `mission-planner`).
 */
const RETIRED_SKILLS = ["octobots"] as const;

/**
 * Files earlier pack versions installed that no longer exist. Removed on install, so an upgraded
 * workspace never keeps a script the skills no longer mention. Paths are relative to `.claude`.
 */
const RETIRED_FILES = ["skills/mission-planner/scripts/set-step.js"] as const;

/** Skill ids an agent needs to drive Octobots. Today every agent needs the whole pack. */
export function requiredSkillsForAgent(_agent: string): string[] {
  return [...OCTOBOTS_SKILLS];
}

/** Read the `version:` integer from frontmatter; null if absent/unparseable. */
export function parseVersion(text: string): number | null {
  const m = text.match(/^version:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/**
 * Read the `// octobots-pack-version: N` marker from the primer script; null if absent.
 * Delegates to the shared rule (`pack-version-marker.ts`) — same marker, one spelling.
 */
export function parsePrimerVersion(text: string): number | null {
  return parsePackVersionMarker(text);
}

export interface PackStatus {
  installed: boolean;
  currentVersion: number;
  upToDate: boolean;
}

/** Inspect the installed pack: installed only if all payloads exist; up-to-date only if all match. */
export function packStatus(repoRoot: string, currentVersion = OCTOBOTS_PACK_VERSION): PackStatus {
  const skills = OCTOBOTS_SKILLS.map((s) => join(repoRoot, ".claude", "skills", s, "SKILL.md"));
  const primer = join(repoRoot, ".octobots", "hooks", "primer.mjs");
  if (skills.some((s) => !existsSync(s)) || !existsSync(primer)) {
    return { installed: false, currentVersion, upToDate: false };
  }
  const skillVs = skills.map((s) => {
    try { return parseVersion(readFileSync(s, "utf8")); } catch { return null; }
  });
  let primerV: number | null;
  try { primerV = parsePrimerVersion(readFileSync(primer, "utf8")); } catch { primerV = null; }
  // Hooks being ABSENT is a legitimate choice (they are opt-in). Settings being UNREADABLE is not
  // the same thing: we cannot tell what is registered, so we must not let "absent" stand in for
  // "fine" and report the pack up-to-date on a file we failed to parse.
  let claude: { present: boolean; current: boolean };
  let claudeReadable = true;
  try { claude = claudeHookStatus(repoRoot, currentVersion); }
  catch { claude = { present: false, current: false }; claudeReadable = false; }
  // The tokenomics CLI is pack payload too: the mission gate is told to run it, so a pack without
  // it is incomplete, not merely missing an extra.
  const tokenomics = tokenomicsStatus(repoRoot, currentVersion);
  if (skillVs.some((v) => v === null) || primerV === null || !tokenomics.present) {
    return { installed: false, currentVersion, upToDate: false };
  }
  // Graph (octograph, M6) is opt-in via its own "Install Graph" command — a workspace that never
  // ran it must not be reported not-installed just because this optional payload is absent. Once
  // installed, though, staleness feeds the same `upToDate` verdict a stale skill/primer/tokenomics
  // already drives: one drift mechanism, not a second one bolted on beside it.
  // Hooks are opt-in too (see `installPack`), so their ABSENCE is a legitimate choice, not a broken
  // install — treating it as one would report a workspace that declined them as uninstalled forever
  // and re-prompt on every open. Once present, staleness feeds `upToDate` exactly as graph's does,
  // which is what lets an upgrade repair the duplicate entries older versions left behind.
  const graph = graphStatus(repoRoot, currentVersion);
  const upToDate =
    skillVs.every((v) => v === currentVersion) && primerV === currentVersion &&
    claudeReadable && (!claude.present || claude.current) &&
    tokenomics.current && (!graph.present || graph.current);
  return { installed: true, currentVersion, upToDate };
}

/** Recursively copy a directory tree, counting files written. */
function copyTree(from: string, to: string): number {
  let written = 0;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const f = join(from, entry.name);
    const t = join(to, entry.name);
    if (entry.isDirectory()) written += copyTree(f, t);
    else if (statSync(f).isFile()) { copyFileSync(f, t); written++; }
  }
  return written;
}

/**
 * Install the pack from `srcRoot` (the resources/octobots-pack dir) into <repoRoot>:
 * each skill → .claude/skills/<name>, the session primer and its Claude hook, and the tokenomics
 * CLI → .octobots/tokenomics. Skill dirs retired by a rename are removed first, so an upgrade never
 * leaves two copies on disk. The graph payload (`.claude/skills/graph/octograph.mjs`) is refreshed
 * here too, but only when already present — see `graphStatus`'s doc comment for why it's opt-in.
 *
 * The pack installs **no agents**. Planning and execution run under whatever agent the user is
 * already in, driven by the skills; agent rosters belong to the repo, not to us.
 */
export function installPack(
  srcRoot: string,
  repoRoot: string,
  opts: { hooks?: boolean; statusline?: boolean; tools?: boolean } = {},
): { written: number; hooksRegistered: boolean; statusline: "registered" | "foreign" | "skipped"; tools: "installed" | "failed" | "skipped" } {
  let written = 0;
  for (const name of RETIRED_SKILLS) {
    rmSync(join(repoRoot, ".claude", "skills", name), { recursive: true, force: true });
  }
  for (const rel of RETIRED_FILES) {
    rmSync(join(repoRoot, ".claude", rel), { force: true });
  }
  for (const name of OCTOBOTS_SKILLS) {
    written += copyTree(
      join(srcRoot, "skill", name),
      join(repoRoot, ".claude", "skills", name),
    );
  }
  written += installPrimer(srcRoot, repoRoot);
  written += installTokenomics(srcRoot, repoRoot);
  // Graph is opt-in (see `graphStatus`'s doc comment): a general pack (re)install only refreshes
  // an already-present graph payload, so re-running this after an upgrade is what clears the
  // staleness `packStatus` flagged — without silently installing graph into a workspace that
  // never asked for it via "Octobots: Install Graph".
  if (graphStatus(repoRoot, OCTOBOTS_PACK_VERSION).present) {
    written += installGraph(srcRoot, repoRoot);
  }
  // Hooks are OPT-IN, on the same doctrine as graph above: they run on every session start and
  // after every Bash tool call, so installing them into a workspace that never asked for them
  // changes how that repo's agents behave — and costs a process per tool call. `opts.hooks === true`
  // is an explicit yes; otherwise we only REFRESH hooks that are already registered, which is what
  // keeps upgrades (and the duplicate-entry repair in `registerClaudeHook`) working without ever
  // adding them behind the user's back. `opts.hooks === false` is a deliberate no — it clears ours.
  const already = claudeHookStatus(repoRoot, OCTOBOTS_PACK_VERSION).present;
  let hooksRegistered = false;
  if (opts.hooks === false) {
    unregisterClaudeHook(repoRoot);
  } else if (opts.hooks === true || already) {
    registerClaudeHook(repoRoot, OCTOBOTS_PACK_VERSION);
    hooksRegistered = true;
  }
  // The status line follows the hooks rule exactly — opt-in, refresh-if-present — with one addition:
  // `statusLine` holds a SINGLE entry, so registering ours over a status line we did not write would
  // delete it irrecoverably. `registerStatusline` refuses that case and reports `foreign` instead.
  const slBefore = statuslineStatus(repoRoot, OCTOBOTS_PACK_VERSION);
  let statusline: "registered" | "foreign" | "skipped" = "skipped";
  if (opts.statusline === false) {
    unregisterStatusline(repoRoot);
  } else if (opts.statusline === true || slBefore.registered) {
    written += installStatusline(srcRoot, repoRoot);
    statusline = registerStatusline(repoRoot);
  }
  // `.octobots/tools` follows the same tri-state, with one difference that earns its own note: this
  // is the ONLY pack step that needs the network, so it is never attempted without an explicit yes,
  // and a failure is reported rather than raised — tokenomics still works via `npx`, just slowly.
  let tools: "installed" | "failed" | "skipped" = "skipped";
  if (opts.tools === false) {
    removeTools(repoRoot);
  } else if (opts.tools === true || toolsStatus(repoRoot).ccusage) {
    tools = installTools(repoRoot) ? "installed" : "failed";
  }
  return { written, hooksRegistered, statusline, tools };
}
