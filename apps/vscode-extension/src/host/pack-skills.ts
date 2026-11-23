/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer", "octobots-doctor"] as const;

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

/**
 * The tokenomics CLI is judged like a skill's SKILL.md (#191): a workspace file whose body the pack
 * shipped is replaced, any other body is a local change and is kept and staged for reconcile. Its
 * bodies sit in the shipped store under `tokenomics/<file>`; its pending entries are named
 * `tokenomics-<file slug>` (`collect.mjs` -> `tokenomics-collect-mjs`), a shape every pending.json
 * reader already accepts, so the record needs no new field.
 */
export const TOKENOMICS_KEY_PREFIX = "tokenomics/";
export const TOKENOMICS_ENTRY_PREFIX = "tokenomics-";
/** The workspace's own after the first install (`PRESERVED` in octobots-tokenomics.ts): never judged. */
export const TOKENOMICS_UNJUDGED: ReadonlySet<string> = new Set(["prices.json", "prices.local.json"]);

/** The pending entry name of a tokenomics file: `tokenomics-` plus its lower-cased name, non-alphanumerics as `-`. */
export const tokenomicsEntryName = (file: string): string =>
  TOKENOMICS_ENTRY_PREFIX + file.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The workspace path of a tokenomics file, relative to the root, with `/`. */
export const tokenomicsRel = (file: string): string => `.octobots/tokenomics/${file}`;
