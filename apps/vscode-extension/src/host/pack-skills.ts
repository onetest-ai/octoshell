/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer"] as const;

/**
 * Skill dirs earlier pack versions installed that no longer exist. Removed on install so an
 * agent never sees a renamed skill twice (v18's `octobots` is now `mission-planner`).
 */
export const RETIRED_SKILLS = ["octobots", "workflow-designer"] as const;
