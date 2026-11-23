import { packFileEntryName, packFileRel } from "./pack-files.js";

/** The skills the pack ships, by directory name under `skill/` and `.claude/skills/`. */
export const OCTOBOTS_SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer", "octobots-doctor"] as const;

export { RETIRED_SKILLS, RETIRED_SKILL_FILES } from "./pack-files.js";

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
export const tokenomicsEntryName = (file: string): string => packFileEntryName(TOKENOMICS_KEY_PREFIX + file);

/** The workspace path of a tokenomics file, relative to the root, with `/`. */
export const tokenomicsRel = (file: string): string => packFileRel(TOKENOMICS_KEY_PREFIX + file);
