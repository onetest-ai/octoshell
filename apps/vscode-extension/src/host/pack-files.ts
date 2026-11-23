/**
 * The pack-path model: every file the pack ships is named by its path under
 * `resources/octobots-pack/` (`skill/mission-planner/scripts/validate.js`, `hooks/primer.mjs`,
 * `statusline/statusline.sh`, `tokenomics/collect.mjs`). One module answers which of them are
 * judged (a changed workspace copy is kept and staged), where each lands in a workspace, and what
 * its pending entry is called. This module imports nothing from the host, so any of them can use it.
 */

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
 * Files earlier pack versions installed that no longer exist, as pack paths. Removed on install, so
 * an upgraded workspace never keeps a script the skills no longer mention.
 */
export const RETIRED_FILES = [
  "skill/mission-planner/scripts/set-step.js",
  // Workflow support was removed (direct sub-agent dispatch replaced the Workflow tool). Only pack
  // files are listed: a user's `.octobots/**/workflows/` folders are data and are never touched.
  "skill/mission-planner/scripts/add-workflow.js",
  "skill/mission-planner/scripts/sync-meta.js",
  "skill/mission-planner/scripts/add-run.js",
  "skill/mission-planner/scripts/mission-input.js",
  "skill/mission-planner/scripts/extract-meta.mjs",
  "skill/mission-planner/scripts/workflow-meta.mjs",
  "skill/mission-planner/scripts/vendor/acorn.mjs",
] as const;

/** The workspace's own after the first install: kept and reported, never judged or staged. */
const TOKENOMICS_UNJUDGED: ReadonlySet<string> = new Set(["prices.json", "prices.local.json"]);

/**
 * Is `packPath` a file whose changed workspace copy is kept and staged for reconcile? Every file
 * under `skill/<skill>/` but its SKILL.md, every file under `hooks/`, `statusline/statusline.sh`
 * and every top-level `tokenomics/` file. Never: a `.json` file, `graph/`, or anything else.
 */
export function isJudgedPackPath(packPath: string): boolean {
  if (packPath.endsWith(".json")) return false;
  const parts = packPath.split("/");
  if (parts.some((p) => p === "")) return false;
  switch (parts[0]) {
    case "skill":
      return parts.length >= 3 && !(parts.length === 3 && parts[2] === "SKILL.md");
    case "hooks":
      return parts.length >= 2;
    case "statusline":
      return packPath === "statusline/statusline.sh";
    case "tokenomics":
      return parts.length === 2 && !TOKENOMICS_UNJUDGED.has(parts[1]!);
    default:
      return false;
  }
}

/** The workspace path of a pack file, relative to the root, with `/`. */
export function packFileRel(packPath: string): string {
  const parts = packPath.split("/");
  switch (parts[0]) {
    case "skill":
      return `.claude/skills/${parts.slice(1).join("/")}`;
    case "hooks":
      return `.octobots/hooks/${parts.slice(1).join("/")}`;
    case "statusline":
      return `.octobots/${parts.slice(1).join("/")}`;
    case "tokenomics":
      return `.octobots/tokenomics/${parts.slice(1).join("/")}`;
    case "graph":
      return `.claude/${packPath}`;
    default:
      throw new Error(`not a pack path: ${packPath}`);
  }
}

/** The pending entry name of a pack file: lower-cased, runs of non-alphanumerics as one `-`. */
export const packFileEntryName = (packPath: string): string =>
  packPath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Retired judged files as pack paths: `RETIRED_FILES` plus the retired skills' files, minus SKILL.md and `.json`. */
export const RETIRED_PACK_PATHS: readonly string[] = [
  ...RETIRED_FILES,
  ...(Object.entries(RETIRED_SKILL_FILES) as [string, readonly string[]][]).flatMap(([skill, files]) =>
    files.map((f) => `skill/${skill}/${f}`),
  ),
].filter(isJudgedPackPath);

/** The comment syntax a file's `octobots-reconciled-from:` marker is written in. */
export function commentSyntaxOf(packPath: string): "//" | "#" | "<!--" {
  const ext = packPath.slice(packPath.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".ts"].includes(ext)) return "//";
  if (ext === ".md") return "<!--";
  return "#";
}
