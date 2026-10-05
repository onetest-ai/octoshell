import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecoveredBase } from "./pack-deviations.js";
import { PACK_UPDATES_DIR, type PendingEntry } from "./pack-updates.js";

/**
 * Staging folders for pack updates: `.octobots/pack-updates/v<N>/<skill>/`.
 *
 * The installer writes `base.md`, `local.md`, `upstream.md` (a pack skill only) and `RECONCILE.md`.
 * The agent adds `merged.md`, `DECISIONS.md` and optionally `UPSTREAM-CANDIDATES.md`; an Overwrite
 * adds `overwritten-local.md`. The installer deletes the inputs it wrote (and `merged.md`) when it
 * re-stages or the user chooses Overwrite or Keep, and NEVER deletes a decision log, a candidates
 * file or a saved local file. Every write skips a file that already holds the same bytes, so an
 * identical second install changes nothing on disk.
 */

/** Ignore everything except itself and the logs, so those are committed where `.octobots/` is tracked. */
export const PACK_UPDATES_GITIGNORE = "*\n!.gitignore\n!*/\n!*/*/DECISIONS.md\n!*/*/UPSTREAM-CANDIDATES.md\n";

/** Files the installer writes into a staging folder, and may delete again. `merged.md` is stale once they change. */
const INPUT_FILES = ["base.md", "local.md", "upstream.md", "RECONCILE.md", "merged.md"] as const;

const stagingRoot = (repoRoot: string): string => join(repoRoot, ".octobots", "pack-updates");

/** Workspace-relative staging folder, with `/`. */
export const stagingDirRel = (packVersion: number, skill: string): string => `${PACK_UPDATES_DIR}/v${packVersion}/${skill}`;

/** Writes `content` to `file` unless it already holds exactly these bytes. True when it wrote. */
export function writeIfChanged(file: string, content: string | Buffer): boolean {
  const next = typeof content === "string" ? Buffer.from(content) : content;
  if (existsSync(file)) {
    try { if (readFileSync(file).equals(next)) return false; } catch { /* rewrite below */ }
  }
  writeFileSync(file, next);
  return true;
}

export function ensureGitignore(repoRoot: string): void {
  mkdirSync(stagingRoot(repoRoot), { recursive: true });
  writeIfChanged(join(stagingRoot(repoRoot), ".gitignore"), PACK_UPDATES_GITIGNORE);
}

/** Open (`- ESCALATED:`) lines of a DECISIONS.md. */
export function openEscalations(decisions: string): string[] {
  return decisions.split(/\r?\n/).filter((l) => /^\s*-\s+ESCALATED:/.test(l)).map((l) => l.trimEnd());
}

export interface CarriedBlock {
  /** The pack version of the folder the questions came from. */
  version: number;
  lines: string[];
}

const CARRIED_HEAD = /^Carried over from v(\d+):\s*$/;

/** The `Carried over from v<N>:` blocks of a RECONCILE.md. */
export function carriedBlocks(brief: string): CarriedBlock[] {
  const out: CarriedBlock[] = [];
  const lines = brief.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(CARRIED_HEAD);
    if (!m) continue;
    const block: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") block.push(lines[++i]!);
    out.push({ version: Number(m[1]), lines: block });
  }
  return out;
}

/**
 * Questions a re-staged entry inherits from the entry it replaces: the open ESCALATED entries of
 * its DECISIONS.md, or, when the agent never ran there, the blocks its RECONCILE.md itself carried.
 */
export function carriedFrom(repoRoot: string, prior: PendingEntry | undefined, priorVersion: number): CarriedBlock[] {
  if (!prior) return [];
  const dir = join(repoRoot, ...prior.dir.split("/"));
  const decisions = join(dir, "DECISIONS.md");
  if (existsSync(decisions)) {
    try {
      const lines = openEscalations(readFileSync(decisions, "utf8"));
      return lines.length > 0 ? [{ version: priorVersion, lines }] : [];
    } catch { return []; }
  }
  try { return carriedBlocks(readFileSync(join(dir, "RECONCILE.md"), "utf8")); } catch { return []; }
}

export interface BriefInput {
  skill: string;
  packVersion: number;
  retired: boolean;
  localVersion: string;
  localSha256: string;
  base: RecoveredBase | null;
  upstreamSha256: string | null;
  carried: CarriedBlock[];
}

/** The brief an agent reads first. Deterministic: the same inputs give the same bytes. */
export function renderBrief(b: BriefInput): string {
  const baseLine = b.base === null
    ? "none; the merge is two-way (local against upstream)"
    : `v${b.base.version}, sha256 ${b.base.sha256}, source ${b.base.source}${b.base.source === "closest" ? " (approximate: the stored body closest to the local file)" : ""}`;
  const out = [
    `# Reconcile ${b.skill} (pack v${b.packVersion})`,
    "",
    `- Skill: ${b.skill}`,
    `- Local version: ${b.localVersion} (sha256 ${b.localSha256})`,
    `- Base: ${baseLine}`,
    b.retired
      ? `- Upstream: none. The pack retired this skill in v${b.packVersion}, so upstream deleted it.`
      : `- Upstream: pack v${b.packVersion} (sha256 ${b.upstreamSha256})`,
    "",
  ];
  for (const c of b.carried) out.push(`Carried over from v${c.version}:`, ...c.lines, "");
  out.push(
    "Inputs in this folder: local.md" + (b.base ? ", base.md" : "") + (b.retired ? "." : ", upstream.md."),
    "",
    "Run the octobots-doctor skill; do not edit the live SKILL.md by hand.",
    "",
  );
  if (b.retired) {
    out.push(
      "This skill is retired. Its upstream is deletion, so there is nothing to merge. The decision is the user's:",
      "keep it as a project skill under a new directory name, or delete it. Ask; do not decide.",
      "",
    );
  } else {
    out.push(
      "Merge per change (local only: keep; upstream only: take; both the same: take; both different: conflict).",
      "Write merged.md and DECISIONS.md here; escalate any policy conflict to the user.",
      "",
    );
  }
  return out.join("\n");
}

/** Removes the installer's inputs from a staging folder (never a log), then the folder if it is empty. */
export function clearInputs(repoRoot: string, dirRel: string): void {
  const dir = join(repoRoot, ...dirRel.split("/"));
  if (!existsSync(dir)) return;
  for (const f of INPUT_FILES) rmSync(join(dir, f), { force: true });
  pruneStaging(dir);
}

/** Removes `dir` (and its `v<N>` parent) when nothing is left in it: a folder holding a log stays. */
export function pruneStaging(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
    const parent = join(dir, "..");
    if (/v\d+$/.test(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  } catch { /* already gone, or not empty */ }
}

export interface StageInput extends BriefInput {
  repoRoot: string;
  localBytes: Buffer;
  upstreamBytes: Buffer | null;
  /** The folder of the entry this one replaces, when it is not this one's folder. */
  replacedDir?: string;
  /** Delete a stale `merged.md`: the entry is being re-staged. */
  restage: boolean;
}

/** Writes one skill's staging folder and returns its pending entry. */
export function stageEntry(s: StageInput): PendingEntry {
  const dirRel = stagingDirRel(s.packVersion, s.skill);
  const dir = join(s.repoRoot, ...dirRel.split("/"));
  mkdirSync(dir, { recursive: true });
  if (s.restage) rmSync(join(dir, "merged.md"), { force: true });
  writeIfChanged(join(dir, "local.md"), s.localBytes);
  if (s.base) writeIfChanged(join(dir, "base.md"), s.base.body); else rmSync(join(dir, "base.md"), { force: true });
  if (s.upstreamBytes) writeIfChanged(join(dir, "upstream.md"), s.upstreamBytes); else rmSync(join(dir, "upstream.md"), { force: true });
  writeIfChanged(join(dir, "RECONCILE.md"), renderBrief(s));
  if (s.replacedDir && s.replacedDir !== dirRel) clearInputs(s.repoRoot, s.replacedDir);
  return {
    skill: s.skill,
    action: "reconcile",
    localVersion: s.localVersion,
    localSha256: s.localSha256,
    base: s.base ? { version: s.base.version, sha256: s.base.sha256, source: s.base.source } : null,
    upstreamSha256: s.upstreamSha256,
    retired: s.retired,
    dir: dirRel,
  };
}

/** Saves a replaced local SKILL.md beside its staging folder. Never replaces an earlier saved file. */
export function saveOverwritten(repoRoot: string, packVersion: number, skill: string, local: Buffer): void {
  const dir = join(repoRoot, ...stagingDirRel(packVersion, skill).split("/"));
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const file = join(dir, n === 1 ? "overwritten-local.md" : `overwritten-local.${n}.md`);
    if (!existsSync(file)) { writeFileSync(file, local); return; }
    if (readFileSync(file).equals(local)) return;
  }
}
