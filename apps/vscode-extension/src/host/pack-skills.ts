/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer"] as const;

/**
 * Skill dirs earlier pack versions installed that no longer exist. Removed on install so an
 * agent never sees a renamed skill twice (v18's `octobots` is now `mission-planner`).
 */
export const RETIRED_SKILLS = ["octobots", "workflow-designer"] as const;

/**
 * Every file a retired skill ever shipped, relative to its directory (from the pack's git history,
 * 2026-10-05). Retiring a skill removes exactly these and prunes the directories they leave empty:
 * a file a user added to the directory (`my-notes.md`) is kept in place and reported, never deleted.
 */
export const RETIRED_SKILL_FILES: Record<(typeof RETIRED_SKILLS)[number], readonly string[]> = {
  octobots: [
    "SKILL.md",
    "scripts/add-bug.js",
    "scripts/add-doc.js",
    "scripts/add-task.js",
    "scripts/create-team.js",
    "scripts/delete-bug.js",
    "scripts/delete-task.js",
    "scripts/list.js",
    "scripts/package.json",
    "scripts/set-criterion.js",
    "scripts/set-status.js",
    "scripts/show.js",
    "scripts/validate.js",
  ],
  "workflow-designer": ["SKILL.md"],
};
