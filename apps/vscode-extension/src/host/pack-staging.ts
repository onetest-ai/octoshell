import { lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { RecoveredBase } from "./pack-deviations.js";
import { commentSyntaxOf, packFileRel } from "./pack-files.js";
import { PACK_UPDATES_DIR, assertRealPackUpdatesDir, isStagingDir, readRegularBytes, readRegularText, type PendingEntry } from "./pack-updates.js";

/**
 * Staging folders for pack updates: `.octobots/pack-updates/v<N>/<skill>/`.
 *
 * The installer writes `base.md`, `local.md`, `upstream.md` (only for a skill or file the pack still ships) and `RECONCILE.md`.
 * The agent adds `merged.md`, `DECISIONS.md` and optionally `UPSTREAM-CANDIDATES.md`; an Overwrite
 * adds `overwritten-local.md`. The installer deletes the inputs it wrote (and `merged.md`) when it
 * re-stages or the user chooses Overwrite or Keep, and NEVER deletes a decision log, a candidates
 * file or a saved local file. Every write skips a file that already holds the same bytes, so an
 * identical second install changes nothing on disk.
 *
 * Everything under `.octobots/pack-updates/` is user-editable (and may be committed), while what the
 * installer writes there includes the workspace's own SKILL.md text. So nothing is ever written or
 * deleted THROUGH a symlink: every folder from `pack-updates/` down must be a real directory (else
 * the install refuses before its first write), and a file is replaced by unlinking whatever is at
 * its path and creating it afresh (`wx`), never by opening an existing entry for writing.
 */

/** Ignore everything except itself and the logs, so those are committed where `.octobots/` is tracked. */
export const PACK_UPDATES_GITIGNORE = "*\n!.gitignore\n!*/\n!*/*/DECISIONS.md\n!*/*/UPSTREAM-CANDIDATES.md\n";

/** Files the installer writes into a staging folder, and may delete again. `merged.md` is stale once they change. */
const INPUT_FILES = ["base.md", "local.md", "upstream.md", "RECONCILE.md", "merged.md"] as const;

const stagingRoot = (repoRoot: string): string => join(repoRoot, ".octobots", "pack-updates");

const lstatOrNull = (p: string): Stats | null => {
  try { return lstatSync(p); } catch { return null; }
};

/**
 * The absolute path of a workspace-relative staging folder, or null when `dirRel` is not of the
 * shape `.octobots/pack-updates/v<N>/<skill>` (a folder read from pending.json can never steer a
 * read or a delete outside `.octobots/pack-updates/`) or, unless `create`, when it does not exist.
 * Throws when `pack-updates/`, `v<N>/` or `<skill>/` exists as anything but a real directory (a
 * planted symlink would send the installer's writes and deletes out of the workspace).
 */
export function stagingPath(repoRoot: string, dirRel: string, create = false): string | null {
  if (!isStagingDir(dirRel)) return null;
  const [top, ...rest] = dirRel.split("/");
  let p = join(repoRoot, top!);
  if (create) mkdirSync(p, { recursive: true }); // `.octobots` itself is the user's to place
  for (const part of rest) {
    p = join(p, part);
    const st = lstatOrNull(p);
    if (st === null) {
      if (!create) return null;
      mkdirSync(p);
    } else if (!st.isDirectory()) {
      throw new Error(`${dirRel}: ${part} is not a directory (a symlink?); refusing to write through it`);
    }
  }
  return p;
}

/** Workspace-relative staging folder, with `/`. */
export const stagingDirRel = (packVersion: number, skill: string): string => `${PACK_UPDATES_DIR}/v${packVersion}/${skill}`;

/**
 * Writes `content` to `file` unless it already is a regular file holding exactly these bytes. True
 * when it wrote. Whatever else is at the path (a symlink, a FIFO, a stale file) is unlinked first
 * and the file created with `wx`, so the write never lands outside the folder.
 */
export function writeIfChanged(file: string, content: string | Buffer): boolean {
  const next = typeof content === "string" ? Buffer.from(content) : content;
  const st = lstatOrNull(file);
  if (st?.isFile()) {
    try { if (readRegularBytes(file).equals(next)) return false; } catch { /* rewrite below */ }
  }
  if (st !== null) rmSync(file, { force: true });
  writeFileSync(file, next, { flag: "wx" });
  return true;
}

export function ensureGitignore(repoRoot: string): void {
  assertRealPackUpdatesDir(repoRoot);
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
 * Questions an entry being staged inherits from `dirRel`, the folder of the entry it replaces or,
 * when it has none (an entry dropped earlier), its own folder as it is on disk: the open ESCALATED entries of
 * its DECISIONS.md, or, when the agent never ran there, the blocks its RECONCILE.md itself carried.
 */
export function carriedFrom(repoRoot: string, dirRel: string, version: number): CarriedBlock[] {
  let dir: string | null;
  try { dir = stagingPath(repoRoot, dirRel); } catch { return []; }
  if (!dir) return [];
  const decisions = join(dir, "DECISIONS.md");
  if (lstatOrNull(decisions) !== null) {
    try {
      const lines = openEscalations(readRegularText(decisions));
      return lines.length > 0 ? [{ version, lines }] : [];
    } catch { return []; }
  }
  try { return carriedBlocks(readRegularText(join(dir, "RECONCILE.md"))); } catch { return []; }
}

export interface BriefInput {
  skill: string;
  /** A file's pack path (`tokenomics/collect.mjs`); absent for a skill. */
  file?: string;
  /** The file starts with YAML frontmatter, so its marker line cannot come first. */
  frontmatter?: boolean;
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
  if (b.file !== undefined) return renderFileBrief(b, b.file);
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

/** The brief for a pack file: the same merge, a different live target and marker. */
function renderFileBrief(b: BriefInput, file: string): string {
  const live = packFileRel(file);
  const baseLine = b.base === null
    ? "none; the merge is two-way (local against upstream)"
    : `v${b.base.version}, sha256 ${b.base.sha256}, source ${b.base.source}${b.base.source === "closest" ? " (approximate: the stored body closest to the local file)" : ""}`;
  const out = [
    `# Reconcile ${live} (pack v${b.packVersion})`,
    "",
    `- File: ${live} (pending entry ${b.skill})`,
    `- Local: ${b.localVersion === "unversioned" ? "no pack version marker" : `pack version marker ${b.localVersion}`} (sha256 ${b.localSha256})`,
    `- Base: ${baseLine}`,
    b.retired
      ? `- Upstream: none. The pack retired this file in v${b.packVersion}, so upstream deleted it.`
      : `- Upstream: pack v${b.packVersion} (sha256 ${b.upstreamSha256})`,
    "",
  ];
  for (const c of b.carried) out.push(`Carried over from v${c.version}:`, ...c.lines, "");
  out.push(
    "Inputs in this folder: local.md" + (b.base ? ", base.md" : "") + (b.retired ? "" : ", upstream.md") + ". Each holds the file's text unchanged;",
    "the .md name is only the staging convention.",
    "",
    `The installer kept your ${live} and installed the rest of the pack. Run the octobots-doctor skill;`,
    "do not edit the live file by hand.",
    "",
  );
  if (b.retired) {
    out.push(
      "This file is retired. Its upstream is deletion, so there is nothing to merge. The decision is the user's:",
      "keep it as a project file under a new name outside the pack's paths, or delete it. Ask; do not decide.",
      "",
    );
    return out.join("\n");
  }
  const syntax = commentSyntaxOf(file);
  out.push(
    "Merge per change (local only: keep; upstream only: take; both the same: take; both different: conflict).",
    "Write merged.md and DECISIONS.md here; escalate any policy conflict to the user.",
    "",
    b.frontmatter
      ? "The merged file carries this marker on a line of its own, right after the closing `---` of its frontmatter:"
      : "The merged file carries this marker on a line of its own, first in the file (or right after its `#!` line):",
    `${syntax} octobots-reconciled-from: ${b.upstreamSha256}${syntax === "<!--" ? " -->" : ""}`,
    "",
  );
  return out.join("\n");
}

/** Removes the installer's inputs from a staging folder (never a log), then the folder if it is empty. */
export function clearInputs(repoRoot: string, dirRel: string): void {
  const dir = stagingPath(repoRoot, dirRel);
  if (!dir) return;
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
}

const startsWithFrontmatter = (b: Buffer | null): boolean => b !== null && /^\uFEFF?---\r?\n/.test(b.toString("utf8"));

/**
 * Writes one skill's staging folder and returns its pending entry. A merged.md in it is always stale
 * (it was made from other inputs, possibly for an entry dropped since) and is deleted.
 */
export function stageEntry(s: StageInput): PendingEntry {
  const dirRel = stagingDirRel(s.packVersion, s.skill);
  const dir = stagingPath(s.repoRoot, dirRel, true)!;
  rmSync(join(dir, "merged.md"), { force: true });
  writeIfChanged(join(dir, "local.md"), s.localBytes);
  if (s.base) writeIfChanged(join(dir, "base.md"), s.base.body); else rmSync(join(dir, "base.md"), { force: true });
  if (s.upstreamBytes) writeIfChanged(join(dir, "upstream.md"), s.upstreamBytes); else rmSync(join(dir, "upstream.md"), { force: true });
  writeIfChanged(join(dir, "RECONCILE.md"), renderBrief({ ...s, frontmatter: startsWithFrontmatter(s.localBytes) || startsWithFrontmatter(s.upstreamBytes) }));
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

/** Saves a replaced local SKILL.md or pack file beside its staging folder. Never replaces an earlier saved file. */
export function saveOverwritten(repoRoot: string, packVersion: number, skill: string, local: Buffer): void {
  const dir = stagingPath(repoRoot, stagingDirRel(packVersion, skill), true)!;
  for (let n = 1; ; n++) {
    const file = join(dir, n === 1 ? "overwritten-local.md" : `overwritten-local.${n}.md`);
    const st = lstatOrNull(file);
    if (st === null) { writeFileSync(file, local, { flag: "wx" }); return; }
    if (!st.isFile()) continue; // a symlink or other entry: never written through, never replaced
    try { if (readRegularBytes(file).equals(local)) return; } catch { /* unreadable: take the next name */ }
  }
}
