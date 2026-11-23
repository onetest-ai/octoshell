#!/usr/bin/env node
// The pending-reconcile record, from the agent's side. The installer writes
// .octobots/pack-updates/pending.json; this script lists it and clears ONE entry once its reconcile
// is finished. Nothing else may clear an entry: `done` refuses (exit 3, with the reason) until the
// staging folder's DECISIONS.md has no open `- ESCALATED:` entry and the live skill is in its final
// state.
//
//   node .claude/skills/<this skill>/scripts/pack-reconcile.mjs list [--root <dir>]
//   node .claude/skills/<this skill>/scripts/pack-reconcile.mjs done <skill> [--root <dir>]
//
// done <skill> clears the entry when DECISIONS.md exists with no open ESCALATED entry and
//   - for a pack skill: the live .claude/skills/<skill>/SKILL.md reads `version: <N>+local` (N being
//     the pack version of the entry's staging folder) and `reconciled-from: <sha256 of upstream.md>`,
//     and holds no `<!-- ESCALATED: ... -->` placeholder line (merged.md's stand-in for an unanswered
//     rule; a mention of the form inside other text, e.g. in backticks, is not one);
//   - for a retired skill (`retired` in the entry): .claude/skills/<skill> is gone. A copy the user
//     kept lives on under another directory name;
//   - for a pack file (an entry named `skill-`, `hooks-`, `statusline-` or `tokenomics-<slug>`, e.g.
//     hooks-primer-mjs for .octobots/hooks/primer.mjs; its RECONCILE.md names the live file): the live
//     file holds exactly one comment line `octobots-reconciled-from: <sha256 of upstream.md>` and no
//     `ESCALATED:` placeholder comment line. A retired one: the live file is gone.
// A skill with no entry exits 0 and changes nothing. Exit codes: 0 done / listed, 2 usage, 3 refused.
//
// The workspace is the one this script is installed in (<root>/.claude/skills/<skill>/scripts/), or
// --root <dir>; never the current directory. Dependency-free. Its logic names no skill: which skill is
// retired comes from its pending entry. The shared pack modules are imported from their one fixed
// home (a fixed path, never a search of .claude/skills, so no other skill's code is ever loaded).
// A locally changed copy of either is kept by an install and may be as old as v61, so only names v61
// exported are imported: a missing one would stop this script from loading, and no entry could finish.
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as io from "../../mission-planner/scripts/pending-io.mjs";
import { fileReconciledFrom, parseSkillMarker, skillSha256 } from "../../mission-planner/scripts/skill-marker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "..", "..");

const usage = (msg) => {
  if (msg) console.error(`pack-reconcile: ${msg}`);
  console.error("usage: pack-reconcile.mjs list [--root <dir>]\n       pack-reconcile.mjs done <skill> [--root <dir>]");
  process.exit(2);
};
const refuse = (msg) => {
  console.error(`pack-reconcile: ${msg}`);
  process.exit(3);
};

// ── Arguments ────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let rootArg;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") {
    rootArg = argv[++i];
    if (rootArg === undefined) usage("--root needs a directory");
  } else rest.push(argv[i]);
}
const [cmd, skill, ...extra] = rest;
if (cmd !== "list" && cmd !== "done") usage(cmd === undefined ? "" : `unknown command: ${cmd}`);
if (cmd === "done" && skill === undefined) usage("done needs a skill name");
if (extra.length || (cmd === "list" && skill !== undefined)) usage(`unexpected argument: ${[skill, ...extra].filter(Boolean).join(" ")}`);

function workspaceRoot() {
  if (rootArg !== undefined) return resolve(rootArg);
  // <root>/.claude/skills/<skill>/scripts/pack-reconcile.mjs
  if (basename(SKILLS_DIR) === "skills" && basename(dirname(SKILLS_DIR)) === ".claude") return dirname(dirname(SKILLS_DIR));
  usage(`this copy is not installed under <workspace>/.claude/skills (it is in ${HERE}); pass --root <dir>`);
}
const ROOT = workspaceRoot();

const pending = io.readPending(ROOT);
if (pending.state === "malformed") refuse(`${io.MALFORMED_PENDING_NOTE}; ${io.MALFORMED_PENDING_FIX}`);
const record = pending.state === "ok" ? pending.record : null;

// A pack-file entry's live file is the one its RECONCILE.md names. The brief is user-editable, so the
// path is taken only when it maps back to this very entry. The three rules below are copies of the
// extension's pack-files.ts (packFileRel reversed, isJudgedPackPath, packFileEntryName); the
// extension's test/pack-reconcile-script.test.ts drives every pack path through both.
const FILE_ENTRY = /^(skill|hooks|statusline|tokenomics)-/;
const slugOf = (packPath) => packPath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const ROOTS = [[".claude/skills/", "skill/"], [".octobots/hooks/", "hooks/"], [".octobots/tokenomics/", "tokenomics/"]];
function packPathOf(rel) {
  if (rel === ".octobots/statusline.sh") return "statusline/statusline.sh";
  const root = ROOTS.find(([live]) => rel.startsWith(live));
  return root ? root[1] + rel.slice(root[0].length) : null;
}
function isJudged(packPath) {
  const parts = packPath.split("/");
  if (packPath.endsWith(".json")) return false;
  if (parts[0] === "skill") return parts.length >= 3 && !(parts.length === 3 && /^skill\.md$/i.test(parts[2]));
  return parts[0] === "tokenomics" ? parts.length === 2 : true;
}
/** `{kind: "skill"}`, `{kind: "file", path}` (relative to ROOT, with `/`) or `{kind: "invalid"}`. */
function liveFileOf(entry) {
  if (!FILE_ENTRY.test(entry.skill)) return { kind: "skill" };
  const invalid = { kind: "invalid" };
  let brief;
  try { brief = io.readRegularFile(join(ROOT, ...entry.dir.split("/"), "RECONCILE.md"), { noFollow: true }); } catch { return invalid; }
  const path = brief.match(/^- File: (.+) \(pending entry [a-z0-9-]+\)\r?$/m)?.[1];
  if (path === undefined || /[\\\0]/.test(path) || path.split("/").some((p) => p === "" || p === "." || p === "..")) return invalid; // a leading `/` is an empty segment
  const packPath = packPathOf(path);
  return packPath !== null && isJudged(packPath) && slugOf(packPath) === entry.skill ? { kind: "file", path } : invalid;
}
const INVALID_BRIEF = "RECONCILE.md names no file of this entry; install nothing, and run \"Octobots: Install Octobots Pack\" to stage it again";
/** Is anything at all at `file`, a dangling symlink included? An error other than "absent" counts as yes. */
const present = (file) => {
  try { lstatSync(file); return true; } catch (err) { return err.code !== "ENOENT" && err.code !== "ENOTDIR"; }
};

// The standalone marker line: a copy of withoutReconciledFrom's pattern, which a kept v61 marker module
// lacks. The extension's test/skill-marker-parity.test.ts pins it to both twins.
const MARKER_LINE = /^[ \t]*(?:(?:\/\/|#)[ \t]*octobots-reconciled-from:[ \t]*[0-9a-fA-F]{64}|<!--[ \t]*octobots-reconciled-from:[ \t]*[0-9a-fA-F]{64}[ \t]*-->)[ \t]*(?:\r?\n|$)/m;
const versionOf = (e) => Number(e.dir.match(/\/v(\d+)\//)[1]); // isStagingDir guarantees the shape
const upstreamPath = (e) => join(ROOT, ...e.dir.split("/"), "upstream.md");

// ── list ─────────────────────────────────────────────────────────────────────────────────────
if (cmd === "list") {
  if (!record || record.skills.length === 0) {
    console.log("no pending reconcile");
    process.exit(0);
  }
  for (const e of record.skills) {
    const base = e.base ? `base v${e.base.version} (${e.base.source})` : "no base (two-way)";
    console.log(`${e.skill}: local ${e.localVersion}, ${base}, ${e.retired ? "retired: upstream deleted it" : `upstream v${versionOf(e)}`}`);
    console.log(`  folder: ${e.dir}/`);
    const live = liveFileOf(e);
    if (live.kind === "invalid") {
      console.log(`  file: missing (${INVALID_BRIEF})`);
    } else if (live.kind === "file") {
      console.log(`  file: ${live.path}`);
      if (e.retired) continue;
      let from = "upstream.md is missing";
      try { from = `octobots-reconciled-from: ${skillSha256(io.readRegularFile(upstreamPath(e)))}`; } catch { /* reported as missing */ }
      console.log(`  marker: a comment line holding ${from}`);
    } else if (!e.retired) {
      let from = "upstream.md is missing";
      try { from = `reconciled-from: ${skillSha256(io.readRegularFile(upstreamPath(e)))}`; } catch { /* reported as missing */ }
      console.log(`  marker: version: ${versionOf(e)}+local; ${from}`);
    }
  }
  process.exit(0);
}

// ── done <skill> ─────────────────────────────────────────────────────────────────────────────
const e = record ? record.skills.find((s) => s.skill === skill) : undefined;
if (!e) {
  console.log(`no pending reconcile for ${skill}`);
  process.exit(0);
}

const folder = join(ROOT, ...e.dir.split("/"));
const decisionsFile = join(folder, "DECISIONS.md");
if (!existsSync(decisionsFile)) refuse(`${e.dir}/DECISIONS.md does not exist: write the decision log first`);
// Every file read here is user-editable: read only as a small regular file (a FIFO would hang).
const readOrRefuse = (file, rel, opts) => {
  try { return io.readRegularFile(file, opts); } catch { return refuse(`${rel} is not a readable regular file`); }
};
const open = readOrRefuse(decisionsFile, `${e.dir}/DECISIONS.md`).split(/\r?\n/).filter((l) => /^\s*-\s+ESCALATED:/.test(l)).map((l) => l.trim());
if (open.length) refuse(`${e.dir}/DECISIONS.md has ${open.length} open escalation(s); ask the user and record the answer as \`- RESOLVED (user, <YYYY-MM-DD>): ...\`:\n${open.map((l) => `  ${l}`).join("\n")}`);

const liveDir = join(ROOT, ".claude", "skills", skill);
const liveFile = liveFileOf(e);
if (liveFile.kind === "invalid") {
  refuse(`${e.dir}/${INVALID_BRIEF}`);
} else if (liveFile.kind === "file" && e.retired) {
  if (present(join(ROOT, ...liveFile.path.split("/")))) refuse(`${liveFile.path} still exists: this file is retired, so it must be deleted or moved as the user answers first`);
} else if (liveFile.kind === "file") {
  const rel = liveFile.path;
  const file = join(ROOT, ...rel.split("/"));
  if (!present(file)) refuse(`${rel} does not exist: install merged.md there first`);
  if (!existsSync(upstreamPath(e))) refuse(`${e.dir}/upstream.md is missing, so octobots-reconciled-from cannot be checked`);
  const liveText = readOrRefuse(file, rel, { noFollow: true });
  const want = skillSha256(readOrRefuse(upstreamPath(e), `${e.dir}/upstream.md`));
  // A marker is a whole comment line, as the installer strips it. It strips only
  // one, so a second would leave the file a local change for good.
  const markers = liveText.split(/\r?\n/).filter((l) => MARKER_LINE.test(l));
  if (markers.length > 1) refuse(`${rel} holds ${markers.length} octobots-reconciled-from lines; it must hold exactly one, with ${want}:\n${markers.map((l) => `  ${l.trim()}`).join("\n")}`);
  const from = markers.length ? fileReconciledFrom(markers[0]) : null;
  if (from !== want) refuse(`${rel} reads octobots-reconciled-from: ${from ?? "(none)"}; it must hold a comment line octobots-reconciled-from: ${want} (the sha256 of ${e.dir}/upstream.md), with nothing else on that line`);
  if (fileReconciledFrom(liveText) !== want) refuse(`${rel} mentions another octobots-reconciled-from: hash above its marker line, and the installer reads the first; move the marker line above it`);
  const placeholders = liveText.split(/\r?\n/).filter((l) => /^\s*(\/\/|#|<!--)\s*ESCALATED:/.test(l)).map((l) => l.trim());
  if (placeholders.length) refuse(`${rel} still holds ${placeholders.length} \`ESCALATED:\` placeholder line(s); every escalated rule needs the user's answer applied before the merge is installed:\n${placeholders.map((l) => `  ${l}`).join("\n")}`);
} else if (e.retired) {
  if (existsSync(liveDir)) refuse(`.claude/skills/${skill} still exists: this skill is retired, so it must be deleted or moved to a directory name of the user's choosing first`);
} else {
  const n = versionOf(e);
  const live = join(liveDir, "SKILL.md");
  if (!existsSync(live)) refuse(`.claude/skills/${skill}/SKILL.md does not exist: install merged.md there first`);
  if (!existsSync(upstreamPath(e))) refuse(`${e.dir}/upstream.md is missing, so reconciled-from cannot be checked`);
  const liveText = readOrRefuse(live, `.claude/skills/${skill}/SKILL.md`);
  const m = parseSkillMarker(liveText);
  if (m.kind !== "plus-local" || m.n !== n) refuse(`.claude/skills/${skill}/SKILL.md reads version: ${m.label ?? "(none)"}; it must read version: ${n}+local`);
  const want = skillSha256(readOrRefuse(upstreamPath(e), `${e.dir}/upstream.md`));
  if (m.reconciledFrom?.toLowerCase() !== want) refuse(`.claude/skills/${skill}/SKILL.md reads reconciled-from: ${m.reconciledFrom ?? "(none)"}; it must read reconciled-from: ${want} (the sha256 of ${e.dir}/upstream.md)`);
  const placeholders = liveText.split(/\r?\n/).filter((l) => /^\s*<!-- ESCALATED:.*-->\s*$/.test(l)).map((l) => l.trim());
  if (placeholders.length) refuse(`.claude/skills/${skill}/SKILL.md still holds ${placeholders.length} \`<!-- ESCALATED: ... -->\` placeholder line(s); every escalated rule needs the user's answer applied before the merge is installed:\n${placeholders.map((l) => `  ${l}`).join("\n")}`);
}

io.writePending(ROOT, { ...record, skills: record.skills.filter((s) => s.skill !== skill) });
console.log(`reconcile of ${skill} is done; its entry is cleared and ${e.dir}/ is kept`);
