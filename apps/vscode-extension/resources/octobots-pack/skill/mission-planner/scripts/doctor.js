#!/usr/bin/env node
// Octobots doctor — check that this workspace is configured the way the pack expects.
//
//   node .claude/skills/mission-planner/scripts/doctor.js [--root <dir>] [--json]
//
// Exits 0 when everything is fine or only NOTEs remain, 1 when any FAIL is reported. Warnings do
// not fail the run: a workspace that deliberately declined hooks or the status line is healthy.
//
// The config-dir check reports where Claude Code writes this project's transcripts, which is the
// root the tokenomics collector reads: $CLAUDE_CONFIG_DIR/projects/<slug>, else ~/.claude/projects/<slug>
// (<slug> is the main checkout's absolute path with every non-alphanumeric character as "-"). The
// default is healthy: the collector reads only this project's own slug directory, so a shared
// ~/.claude does not mix repos. This must be run from a real shell, because CLAUDE_CONFIG_DIR is an
// environment variable.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { findLegacyWorkflowFolders, NO_LONGER_READ } from "./legacy-workflows.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(flag("--root") ?? process.cwd());
const JSON_OUT = argv.includes("--json");

const findings = [];
const ok = (area, msg) => findings.push({ level: "ok", area, msg });
const warn = (area, msg, fix) => findings.push({ level: "warn", area, msg, fix });
const fail = (area, msg, fix) => findings.push({ level: "fail", area, msg, fix });
const note = (area, msg) => findings.push({ level: "note", area, msg });

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// ── 1. Transcript root (CLAUDE_CONFIG_DIR) ──────────────────────────────────────────────────
// Transcripts live under the MAIN checkout's slug, so a worktree path is unwound first.
const wtAt = ROOT.indexOf(`${sep}.claude${sep}worktrees${sep}`);
const MAIN_ROOT = wtAt !== -1 ? ROOT.slice(0, wtAt) : ROOT;
const SLUG = MAIN_ROOT.replace(/[^A-Za-z0-9]/g, "-");
const ccd = process.env.CLAUDE_CONFIG_DIR;
if (!ccd) {
  ok("config-dir", `CLAUDE_CONFIG_DIR is not set — transcripts are read from ~/.claude/projects/${SLUG}`);
} else {
  ok("config-dir", `CLAUDE_CONFIG_DIR is set — transcripts are read from ${join(ccd, "projects", SLUG)}`);
}

// ── 2. Pack payload ──────────────────────────────────────────────────────────────────────────
const SKILLS = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer"];
const versionOf = (text) => { const m = String(text).match(/^version:\s*(\d+)\s*$/m); return m ? Number(m[1]) : null; };
const markerOf = (text) => { const m = String(text).match(/^(?:\/\/|#)\s*octobots-pack-version:\s*(\d+)\s*$/m); return m ? Number(m[1]) : null; };

const skillVersions = new Map();
for (const s of SKILLS) {
  const p = join(ROOT, ".claude", "skills", s, "SKILL.md");
  if (!existsSync(p)) { fail("pack", `skill missing: ${s}`, 'run "Octobots: Install Workflow Pack"'); continue; }
  skillVersions.set(s, versionOf(readFileSync(p, "utf8")));
}
const versions = [...skillVersions.values()].filter((v) => v !== null);
const packVersion = versions.length ? Math.max(...versions) : null;
if (versions.length && new Set(versions).size > 1) {
  fail("pack", `skills disagree on version: ${[...skillVersions].map(([k, v]) => `${k}=${v}`).join(", ")}`,
    'run "Octobots: Install Workflow Pack" to bring them to one version');
} else if (packVersion !== null) {
  ok("pack", `${skillVersions.size} skills installed at v${packVersion}`);
}

const primer = join(ROOT, ".octobots", "hooks", "primer.mjs");
if (!existsSync(primer)) fail("pack", "primer.mjs is missing", 'run "Octobots: Install Workflow Pack"');
else {
  const v = markerOf(readFileSync(primer, "utf8"));
  if (packVersion !== null && v !== packVersion) {
    fail("pack", `primer.mjs is v${v}, skills are v${packVersion}`, 'run "Octobots: Install Workflow Pack"');
  } else ok("pack", `primer.mjs v${v}`);
}

// ── 3. Hooks: registered, and NOT duplicated ─────────────────────────────────────────────────
const settingsPath = join(ROOT, ".claude", "settings.json");
const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
if (existsSync(settingsPath) && settings === null) {
  fail("settings", `.claude/settings.json is not valid JSON — nothing below could be checked`, "fix the JSON by hand");
}
const hooks = (settings && settings.hooks) || {};
const OUR_SCRIPTS = [".octobots/hooks/primer.mjs", ".octobots/hooks/work-log.mjs", ".octobots/hooks/mission-gate.mjs"];
const dupes = [];
let ourHookCount = 0;
for (const [event, entries] of Object.entries(hooks)) {
  if (!Array.isArray(entries)) continue;
  const seen = new Map();
  for (const e of entries) {
    for (const h of e.hooks ?? []) {
      const script = OUR_SCRIPTS.find((s) => String(h.command ?? "").includes(s));
      if (!script) continue;
      ourHookCount++;
      const key = `${event}:${script}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of seen) if (n > 1) dupes.push(`${key} x${n}`);
}
if (dupes.length) {
  fail("hooks", `duplicate hook registrations — each fires ${dupes.length > 1 ? "multiple times" : "twice"} per event:\n    ${dupes.join("\n    ")}`,
    'run "Octobots: Install Workflow Pack" with a current Octobots extension — the de-duplication is in the installer, so an older extension will re-create the pair');
} else if (ourHookCount === 0) {
  note("hooks", "no Octobots hooks registered — they are opt-in, so this is only a problem if you wanted them");
} else {
  ok("hooks", `${ourHookCount} hook registration(s), no duplicates`);
}

// ── 4. Status line ───────────────────────────────────────────────────────────────────────────
const slScript = join(ROOT, ".octobots", "statusline.sh");
const sl = settings && settings.statusLine;
const slOurs = typeof sl?.command === "string" && sl.command.includes(".octobots/statusline.sh");
if (!sl?.command) {
  note("statusline", "no status line configured — optional");
} else if (!slOurs) {
  note("statusline", `a non-Octobots status line is configured; left alone: ${String(sl.command).slice(0, 60)}`);
} else if (!existsSync(slScript)) {
  fail("statusline", "settings point at .octobots/statusline.sh but the script is missing",
    'run "Octobots: Install Workflow Pack"');
} else {
  const v = markerOf(readFileSync(slScript, "utf8"));
  if (packVersion !== null && v !== packVersion) warn("statusline", `statusline.sh is v${v}, pack is v${packVersion}`, 'run "Octobots: Install Workflow Pack"');
  else ok("statusline", `installed and registered (v${v})`);
  if (String(sl.command).includes("/Users/") || /^[A-Za-z]:\\/.test(String(sl.command))) {
    fail("statusline", `the registration uses an ABSOLUTE path — it breaks on another machine or a fresh clone`,
      'reinstall so it is registered through ${CLAUDE_PROJECT_DIR}');
  }
  // The status line parses its payload with node, not jq — node is already required by every hook,
  // so there is no second system dependency to check for here. Kept as an explicit note rather than
  // deleted silently: an earlier build DID need jq, and a reader of an old doctor report deserves
  // to know the requirement went away rather than assume the check was dropped.
  try { execFileSync("node", ["--version"], { stdio: "ignore" }); }
  catch { fail("statusline", "`node` is not on PATH — the status line and every pack hook need it", "install Node.js"); }
}

// ── 5. Tokenomics + ccusage ──────────────────────────────────────────────────────────────────
if (!existsSync(join(ROOT, ".octobots", "tokenomics"))) {
  fail("tokenomics", "the tokenomics CLI is missing", 'run "Octobots: Install Workflow Pack"');
} else ok("tokenomics", "CLI installed");
// ccusage: the workspace's own copy first — that is the one the pack installs and the scripts use.
const localCcusage = join(ROOT, ".octobots", "tools", "node_modules", ".bin", "ccusage");
if (existsSync(localCcusage)) {
  ok("tokenomics", "ccusage installed in .octobots/tools (no npx resolution per call)");
} else {
  let onPath = false;
  try { execFileSync("ccusage", ["--version"], { stdio: "ignore" }); onPath = true; } catch { /* not on PATH */ }
  if (onPath) note("tokenomics", "ccusage is on PATH — usable, though the pack's own copy is what it installs");
  else warn("tokenomics",
    "ccusage is not installed for this workspace, so every usage call falls back to `npx` — which " +
      "re-resolves a platform-specific native package each time. Measured: 823ms per call against " +
      "29ms for an installed binary, and the usage wait loop makes up to fifteen calls.",
    'run "Octobots: Install Workflow Pack" and accept the tools step (installs once, ~340ms, into .octobots/tools)');
}

// ── 6. Board ─────────────────────────────────────────────────────────────────────────────────
const campaigns = join(ROOT, ".octobots", "campaigns");
if (!existsSync(campaigns)) note("board", "no .octobots/campaigns yet — nothing planned on this board");
else {
  const n = readdirSync(campaigns, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  ok("board", `${n} campaign(s)`);
  // Workflow support was removed in pack v57. These folders are ignored, never touched: warn only.
  const base = join(ROOT, ".octobots");
  const leftovers = readdirSync(campaigns, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => findLegacyWorkflowFolders(join(campaigns, e.name), base));
  if (leftovers.length) {
    warn("board",
      `${leftovers.length} leftover workflows/ folder(s), ${NO_LONGER_READ}: ${leftovers.join(", ")}`,
      "nothing to do — they are ignored and harmless, so you can leave them; to tidy up, move them aside by hand (the doctor never changes them)");
  }
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────
const failed = findings.filter((f) => f.level === "fail");
if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, packVersion, findings, ok: failed.length === 0 }, null, 2));
} else {
  const icon = { ok: "  ok  ", warn: " warn ", fail: " FAIL ", note: " note " };
  console.log(`octobots doctor — ${ROOT}\n`);
  for (const f of findings) {
    console.log(`[${icon[f.level]}] ${f.area.padEnd(11)} ${f.msg}`);
    if (f.fix) console.log(`${" ".repeat(22)}fix: ${f.fix}`);
  }
  const w = findings.filter((f) => f.level === "warn").length;
  console.log(`\n${failed.length} failing, ${w} warning(s), ${findings.filter((f) => f.level === "ok").length} ok`);
}
process.exit(failed.length ? 1 : 0);
