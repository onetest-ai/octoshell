import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installPrimer, registerClaudeHook, claudeHookStatus } from "./octobots-hooks.js";

/** Bump when the skill or either agent payload changes; covers the pack as one unit. */
export const OCTOBOTS_PACK_VERSION = 22;

/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate"] as const;

/**
 * Skill dirs earlier pack versions installed that no longer exist. Removed on install so an
 * agent never sees a renamed skill twice (v18's `octobots` is now `mission-planner`).
 */
const RETIRED_SKILLS = ["octobots"] as const;

/**
 * The planning agents Octoshell owns and bundles in the pack. Now empty: campaign/mission
 * planning runs under the default ACP agent + the octobots skill, so the pack ships the skill only.
 */
export const OCTOBOTS_AGENTS = [] as const;

/** Skill ids an agent needs to drive Octobots. Today every agent needs the whole pack. */
export function requiredSkillsForAgent(_agent: string): string[] {
  return [...OCTOBOTS_SKILLS];
}

/** Read the `version:` integer from frontmatter; null if absent/unparseable. */
export function parseVersion(text: string): number | null {
  const m = text.match(/^version:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/** Read the `// octobots-pack-version: N` marker from the primer script; null if absent. */
export function parsePrimerVersion(text: string): number | null {
  const m = text.match(/octobots-pack-version:\s*(\d+)/);
  return m ? Number(m[1]) : null;
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
  if (skillVs.some((v) => v === null) || primerV === null || !claude.present) {
    return { installed: false, currentVersion, upToDate: false };
  }
  const upToDate =
    skillVs.every((v) => v === currentVersion) && primerV === currentVersion && claude.current;
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
 * each skill → .claude/skills/<name>, each agent → .claude/agents/<name>. Skill dirs retired
 * by a rename are removed first, so an upgrade never leaves two copies on disk.
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
  registerClaudeHook(repoRoot, OCTOBOTS_PACK_VERSION);
  for (const name of OCTOBOTS_AGENTS) {
    written += copyTree(
      join(srcRoot, "agents", name),
      join(repoRoot, ".claude", "agents", name),
    );
  }
  return { written };
}
