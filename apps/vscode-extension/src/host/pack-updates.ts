import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `.octobots/pack-updates/pending.json`: the one record of pack skills staged for an agent to
 * reconcile (and of skills the user chose to keep). This module is the only host-side reader and
 * writer of it. Its shape is defined by `test/fixtures/pending-cases.json`, which the pack's
 * `pending-io.mjs` (doctor.js, validate.js, pack-reconcile.mjs) parses to the same summaries.
 *
 * Strict on the fields it relies on, silent about extras: any violation makes the whole file
 * "malformed", which readers treat as no record at all and `installPack` replaces from its results.
 */

export type BaseSourceName = "reconciled-from" | "workspace-git" | "declared" | "closest";
const BASE_SOURCES: readonly string[] = ["reconciled-from", "workspace-git", "declared", "closest"];

export interface PendingEntry {
  skill: string;
  action: "reconcile";
  /** The version label as written in the workspace's SKILL.md, e.g. `57-local`. */
  localVersion: string;
  localSha256: string;
  /** null under base rule 5: the merge is two-way. */
  base: { version: number; sha256: string; source: BaseSourceName } | null;
  /** null for a retired skill: its upstream is deletion. */
  upstreamSha256: string | null;
  retired: boolean;
  /** Staging folder, relative to the workspace root, with `/`. */
  dir: string;
}

export interface KeptEntry {
  skill: string;
  packVersion: number;
  sha256: string;
}

export interface PendingRecord {
  packVersion: number;
  skills: PendingEntry[];
  kept: KeptEntry[];
}

/** What every reader must agree on for a given file text. */
export interface PendingSummary {
  /** null when the file is malformed. */
  packVersion: number | null;
  reconcile: string[];
  kept: string[];
}

export const PACK_UPDATES_DIR = ".octobots/pack-updates";

/** The most a pending.json may hold; a larger file is malformed (the primer and pending-io.mjs use the same bound). */
export const MAX_PENDING_BYTES = 256 * 1024;
/** The most a SKILL.md or a staging file may hold before the installer refuses to read it. */
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;

/**
 * The bytes of `file`, read ONLY when it is a regular file of at most `max` bytes; throws otherwise.
 * Twin of `readRegularFile` in the pack's pending-io.mjs. pending.json, staging files and a live
 * SKILL.md are user-editable, and a FIFO or a symlink to /dev/zero would block the extension host
 * forever: the file is opened non-blocking and checked with fstat on that same descriptor, so
 * nothing can be swapped in between. `noFollow` also refuses a symlink (pending.json).
 */
export function readRegularBytes(file: string, opts: { max?: number; noFollow?: boolean } = {}): Buffer {
  const max = opts.max ?? MAX_SKILL_BYTES;
  if (opts.noFollow && lstatSync(file).isSymbolicLink()) throw new Error(`${file}: a symlink, not read`);
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (opts.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
  const fd = openSync(file, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file}: not a regular file`);
    if (st.size > max) throw new Error(`${file}: larger than ${max} bytes`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `readRegularBytes` as UTF-8 text. */
export const readRegularText = (file: string, opts: { max?: number; noFollow?: boolean } = {}): string =>
  readRegularBytes(file, opts).toString("utf8");

/**
 * Throws unless `.octobots/pack-updates` under `repoRoot` is absent or a real directory: a planted
 * symlink there would steer every write and delete under it out of the workspace.
 */
export function assertRealPackUpdatesDir(repoRoot: string): void {
  let st;
  try { st = lstatSync(join(repoRoot, ".octobots", "pack-updates")); } catch { return; }
  if (!st.isDirectory()) throw new Error(`${PACK_UPDATES_DIR} is not a directory (a symlink?); refusing to write through it`);
}

export const pendingFile = (repoRoot: string): string => join(repoRoot, ".octobots", "pack-updates", "pending.json");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * pending.json is a user-editable file and the installer deletes files in the folder an entry
 * names, so a skill name and a `dir` are accepted only in their one safe shape: a lower-case
 * skill name, and `.octobots/pack-updates/v<N>/<that skill>`. Anything else (`../x`, an absolute
 * path, another skill's folder, `.octobots/campaigns/...`) makes the file malformed.
 */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const STAGING_DIR = /^\.octobots\/pack-updates\/v(\d+)\/([a-z0-9][a-z0-9-]*)$/;
const isSkillName = (v: unknown): v is string => typeof v === "string" && SKILL_NAME.test(v);

/** True when `dir` is the staging folder `.octobots/pack-updates/v<N>/<skill>` (of `skill`, when given). */
export function isStagingDir(dir: string, skill?: string): boolean {
  const m = STAGING_DIR.exec(dir);
  return m !== null && (skill === undefined || m[2] === skill);
}

function entryOf(v: unknown): PendingEntry | null {
  if (!isObj(v)) return null;
  const { skill, action, localVersion, localSha256, base, upstreamSha256, retired, dir } = v;
  if (!isSkillName(skill) || action !== "reconcile" || !isStr(localVersion) || !isStr(localSha256)) return null;
  if (!(upstreamSha256 === null || isStr(upstreamSha256)) || typeof retired !== "boolean" || !isStr(dir) || !isStagingDir(dir, skill)) return null;
  let b: PendingEntry["base"] = null;
  if (base !== null) {
    if (!isObj(base) || !isInt(base.version) || !isStr(base.sha256) || typeof base.source !== "string" || !BASE_SOURCES.includes(base.source)) return null;
    b = { version: base.version, sha256: base.sha256, source: base.source as BaseSourceName };
  }
  return { skill, action, localVersion, localSha256, base: b, upstreamSha256: upstreamSha256 as string | null, retired, dir };
}

function keptOf(v: unknown): KeptEntry | null {
  if (!isObj(v) || !isSkillName(v.skill) || !isInt(v.packVersion) || !isStr(v.sha256)) return null;
  return { skill: v.skill, packVersion: v.packVersion, sha256: v.sha256 };
}

/** The record in `text`, or null when it is not a well-formed one. */
export function parsePending(text: string): PendingRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObj(raw) || !isInt(raw.packVersion) || !Array.isArray(raw.skills) || !Array.isArray(raw.kept)) return null;
  const skills: PendingEntry[] = [];
  const kept: KeptEntry[] = [];
  const seen = new Set<string>();
  for (const s of raw.skills) {
    const e = entryOf(s);
    if (!e || seen.has(e.skill)) return null;
    seen.add(e.skill);
    skills.push(e);
  }
  for (const k of raw.kept) {
    const e = keptOf(k);
    if (!e || seen.has(e.skill)) return null; // one entry per skill, pending or kept
    seen.add(e.skill);
    kept.push(e);
  }
  return { packVersion: raw.packVersion, skills, kept };
}

export function pendingSummary(text: string): PendingSummary {
  const rec = parsePending(text);
  if (!rec) return { packVersion: null, reconcile: [], kept: [] };
  return { packVersion: rec.packVersion, reconcile: rec.skills.map((s) => s.skill), kept: rec.kept.map((k) => k.skill) };
}

/** Stable key order, 2-space indent, one trailing newline. */
export function serializePending(rec: PendingRecord): string {
  const out = {
    packVersion: rec.packVersion,
    skills: rec.skills.map((s) => ({
      skill: s.skill,
      action: s.action,
      localVersion: s.localVersion,
      localSha256: s.localSha256,
      base: s.base === null ? null : { version: s.base.version, sha256: s.base.sha256, source: s.base.source },
      upstreamSha256: s.upstreamSha256,
      retired: s.retired,
      dir: s.dir,
    })),
    kept: rec.kept.map((k) => ({ skill: k.skill, packVersion: k.packVersion, sha256: k.sha256 })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

/** The record, or null when the file is missing, unreadable or malformed. */
export function readPending(repoRoot: string): PendingRecord | null {
  try { return parsePending(readRegularText(pendingFile(repoRoot), { max: MAX_PENDING_BYTES, noFollow: true })); } catch { return null; }
}

/**
 * Writes the record unless the file already holds exactly these bytes. True when it wrote. The
 * write goes to a temp file renamed over pending.json, so a crash leaves the old record or the new
 * one, never a truncated file.
 */
export function writePending(repoRoot: string, rec: PendingRecord): boolean {
  const file = pendingFile(repoRoot);
  const text = serializePending(rec);
  assertRealPackUpdatesDir(repoRoot);
  try { if (readRegularText(file, { max: MAX_PENDING_BYTES, noFollow: true }) === text) return false; } catch { /* absent or unusable: rewrite below */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { force: true }); // a leftover (or planted) tmp; `wx` below never writes through a link
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return true;
}

/** Skills with a pending reconcile in `repoRoot`'s pending.json. */
export function pendingReconcile(repoRoot: string): string[] {
  return readPending(repoRoot)?.skills.map((s) => s.skill) ?? [];
}
