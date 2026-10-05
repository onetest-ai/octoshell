// The ONE reader and writer of `.octobots/pack-updates/pending.json` on the pack side. The extension
// host has its twin in src/host/pack-updates.ts; the extension's test/pending-io-parity.test.ts drives
// both (and the primer's) from test/fixtures/pending-cases.json and asserts identical
// {packVersion, reconcile, kept}. doctor.js, validate.js and pack-reconcile.mjs import this file.
// Dependency-free on purpose, like the rest of scripts/.
//
//   {packVersion, skills: [{skill, action: "reconcile", localVersion, localSha256,
//                           base: {version, sha256, source} | null, upstreamSha256 | null, retired, dir}],
//    kept: [{skill, packVersion, sha256}]}
//
// Strict on the fields it relies on, silent about extras: any violation makes the whole file
// malformed, which every reader treats as no record at all. pending.json is user-editable and the
// installer deletes files in the folder an entry names, so a skill name and `dir` are accepted only
// in their one safe shape: a lower-case skill name and `.octobots/pack-updates/v<N>/<that skill>`.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";

export const PACK_UPDATES_DIR = ".octobots/pack-updates";
const BASE_SOURCES = ["reconciled-from", "workspace-git", "declared", "closest"];
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const STAGING_DIR = /^\.octobots\/pack-updates\/v(\d+)\/([a-z0-9][a-z0-9-]*)$/;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v !== "";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const isSkillName = (v) => typeof v === "string" && SKILL_NAME.test(v);

/** The most a pending.json may hold; a larger file is malformed (the primer uses the same bound). */
export const MAX_PENDING_BYTES = 256 * 1024;
/** The most a SKILL.md or a staging file may hold before a reader refuses it. */
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;

/**
 * The text of `file`, read ONLY when it is a regular file of at most `max` bytes; throws otherwise.
 * Every file these scripts read here is user-editable (pending.json, staging files, a live SKILL.md),
 * and a FIFO or a symlink to /dev/zero would block the reader forever: the file is opened
 * non-blocking and checked with fstat on that same descriptor, so nothing can be swapped in between.
 * `noFollow` also refuses a symlink (pending.json, as the primer does).
 */
export function readRegularFile(file, { max = MAX_SKILL_BYTES, noFollow = false } = {}) {
  if (noFollow && lstatSync(file).isSymbolicLink()) throw new Error(`${file}: a symlink, not read`);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file}: not a regular file`);
    if (st.size > max) throw new Error(`${file}: larger than ${max} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws unless `.octobots/pack-updates` under `root` is absent or a real directory: a planted
 * symlink there would steer every write and delete under it out of the workspace.
 */
export function assertRealPackUpdatesDir(root) {
  const dir = join(root, ".octobots", "pack-updates");
  let st;
  try { st = lstatSync(dir); } catch { return; }
  if (!st.isDirectory()) throw new Error(`${PACK_UPDATES_DIR} is not a directory (a symlink?); refusing to write through it`);
}

/** pending.json under the workspace `root`. */
export const pendingFile = (root) => join(root, ".octobots", "pack-updates", "pending.json");

/**
 * The workspace root for a path inside its board: the parent of the nearest `.octobots` ancestor of
 * `path`, or null when `path` is not under one (a board copied to a folder with another name).
 */
export function workspaceRootOf(path) {
  for (let d = resolve(path); d !== parse(d).root; d = dirname(d)) if (basename(d) === ".octobots") return dirname(d);
  return null;
}

/** The `warning:` text for a pending.json that cannot be read as a record. */
export const MALFORMED_PENDING_NOTE = `${PACK_UPDATES_DIR}/pending.json is malformed, so no pack reconcile can be listed`;
/** What to do about it: the installer replaces the file from its own results. */
export const MALFORMED_PENDING_FIX = 'run "Octobots: Install Workflow Pack" (it rewrites pending.json), or delete the file';

/** True when `dir` is the staging folder `.octobots/pack-updates/v<N>/<skill>` (of `skill`, when given). */
export function isStagingDir(dir, skill) {
  const m = STAGING_DIR.exec(dir);
  return m !== null && (skill === undefined || m[2] === skill);
}

function entryOf(v) {
  if (!isObj(v)) return null;
  const { skill, action, localVersion, localSha256, base, upstreamSha256, retired, dir } = v;
  if (!isSkillName(skill) || action !== "reconcile" || !isStr(localVersion) || !isStr(localSha256)) return null;
  if (!(upstreamSha256 === null || isStr(upstreamSha256)) || typeof retired !== "boolean" || !isStr(dir) || !isStagingDir(dir, skill)) return null;
  let b = null;
  if (base !== null) {
    if (!isObj(base) || !isInt(base.version) || !isStr(base.sha256) || !BASE_SOURCES.includes(base.source)) return null;
    b = { version: base.version, sha256: base.sha256, source: base.source };
  }
  return { skill, action, localVersion, localSha256, base: b, upstreamSha256, retired, dir };
}

function keptOf(v) {
  if (!isObj(v) || !isSkillName(v.skill) || !isInt(v.packVersion) || !isStr(v.sha256)) return null;
  return { skill: v.skill, packVersion: v.packVersion, sha256: v.sha256 };
}

/** The record in `text`, or null when it is not a well-formed one. */
export function parsePending(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObj(raw) || !isInt(raw.packVersion) || !Array.isArray(raw.skills) || !Array.isArray(raw.kept)) return null;
  const skills = [];
  const kept = [];
  const seen = new Set();
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

/** `{packVersion, reconcile: [skill], kept: [skill]}`; packVersion is null when the file is malformed. */
export function pendingSummary(text) {
  const rec = parsePending(text);
  if (!rec) return { packVersion: null, reconcile: [], kept: [] };
  return { packVersion: rec.packVersion, reconcile: rec.skills.map((s) => s.skill), kept: rec.kept.map((k) => k.skill) };
}

/**
 * `{state: "none"}` when there is no pending.json, `{state: "malformed"}` when it cannot be read as a
 * record, else `{state: "ok", record}`. doctor.js and validate.js warn on "malformed".
 */
export function readPending(root) {
  const file = pendingFile(root);
  try { lstatSync(file); } catch { return { state: "none" }; } // a dangling symlink is present (and malformed)
  let text;
  try { text = readRegularFile(file, { max: MAX_PENDING_BYTES, noFollow: true }); } catch { return { state: "malformed" }; }
  const record = parsePending(text);
  return record ? { state: "ok", record } : { state: "malformed" };
}

/** Stable key order, 2-space indent, one trailing newline: byte-identical to the host's serializer. */
export function serializePending(rec) {
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

/**
 * Writes the record unless the file already holds exactly these bytes; true when it wrote. Through a
 * temp file renamed over pending.json, so a crash leaves the old record or the new one.
 */
export function writePending(root, rec) {
  const file = pendingFile(root);
  const text = serializePending(rec);
  assertRealPackUpdatesDir(root);
  try { if (readRegularFile(file, { max: MAX_PENDING_BYTES, noFollow: true }) === text) return false; } catch { /* absent or unusable: rewrite below */ }
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
