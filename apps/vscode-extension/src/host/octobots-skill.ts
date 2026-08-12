import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installPrimer, registerClaudeHook, claudeHookStatus } from "./octobots-hooks.js";
import { installTokenomics, tokenomicsStatus } from "./octobots-tokenomics.js";
import { installGraph, graphStatus } from "./octograph-install.js";
import { parsePackVersionMarker } from "./pack-version-marker.js";

/** Bump when the skill or either agent payload changes; covers the pack as one unit. */
export const OCTOBOTS_PACK_VERSION = 43;

/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "workflow-designer", "mission-execution", "mission-completion-gate"] as const;

/**
 * Skill dirs earlier pack versions installed that no longer exist. Removed on install so an
 * agent never sees a renamed skill twice (v18's `octobots` is now `mission-planner`).
 */
const RETIRED_SKILLS = ["octobots"] as const;

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
  let claude: { present: boolean; current: boolean };
  try { claude = claudeHookStatus(repoRoot, currentVersion); }
  catch { claude = { present: false, current: false }; }
  // The tokenomics CLI is pack payload too: the mission gate is told to run it, so a pack without
  // it is incomplete, not merely missing an extra.
  const tokenomics = tokenomicsStatus(repoRoot, currentVersion);
  if (skillVs.some((v) => v === null) || primerV === null || !claude.present || !tokenomics.present) {
    return { installed: false, currentVersion, upToDate: false };
  }
  // Graph (octograph, M6) is opt-in via its own "Install Graph" command — a workspace that never
  // ran it must not be reported not-installed just because this optional payload is absent. Once
  // installed, though, staleness feeds the same `upToDate` verdict a stale skill/primer/tokenomics
  // already drives: one drift mechanism, not a second one bolted on beside it.
  const graph = graphStatus(repoRoot, currentVersion);
  const upToDate =
    skillVs.every((v) => v === currentVersion) && primerV === currentVersion && claude.current &&
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
export function installPack(srcRoot: string, repoRoot: string): { written: number } {
  let written = 0;
  for (const name of RETIRED_SKILLS) {
    rmSync(join(repoRoot, ".claude", "skills", name), { recursive: true, force: true });
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
  registerClaudeHook(repoRoot, OCTOBOTS_PACK_VERSION);
  return { written };
}
