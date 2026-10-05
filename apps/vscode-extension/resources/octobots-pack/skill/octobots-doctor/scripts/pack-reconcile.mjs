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
//     kept lives on under another directory name.
// A skill with no entry exits 0 and changes nothing. Exit codes: 0 done / listed, 2 usage, 3 refused.
//
// The workspace is the one this script is installed in (<root>/.claude/skills/<skill>/scripts/), or
// --root <dir>; never the current directory. Dependency-free. Its logic names no skill: which skill is
// retired comes from its pending entry. The shared pack modules are imported from their one fixed
// home (a fixed path, never a search of .claude/skills, so no other skill's code is ever loaded).
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as io from "../../mission-planner/scripts/pending-io.mjs";
import { parseSkillMarker, skillSha256 } from "../../mission-planner/scripts/skill-marker.mjs";

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
    if (!e.retired) {
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
const readOrRefuse = (file, rel) => {
  try { return io.readRegularFile(file); } catch { return refuse(`${rel} is not a readable regular file`); }
};
const open = readOrRefuse(decisionsFile, `${e.dir}/DECISIONS.md`).split(/\r?\n/).filter((l) => /^\s*-\s+ESCALATED:/.test(l)).map((l) => l.trim());
if (open.length) refuse(`${e.dir}/DECISIONS.md has ${open.length} open escalation(s); ask the user and record the answer as \`- RESOLVED (user, <YYYY-MM-DD>): ...\`:\n${open.map((l) => `  ${l}`).join("\n")}`);

const liveDir = join(ROOT, ".claude", "skills", skill);
if (e.retired) {
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
