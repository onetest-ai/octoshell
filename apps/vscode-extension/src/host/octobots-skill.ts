import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { installPrimer, registerClaudeHook, unregisterClaudeHook, claudeHookStatus } from "./octobots-hooks.js";
import { installTokenomics, tokenomicsStatus } from "./octobots-tokenomics.js";
import { installGraph, graphStatus } from "./octograph-install.js";
import { installStatusline, registerStatusline, unregisterStatusline, statuslineStatus } from "./octobots-statusline.js";
import { installTools, removeTools, toolsStatus } from "./octobots-tools.js";
import { parsePackVersionMarker } from "./pack-version-marker.js";
import { OCTOBOTS_SKILLS, RETIRED_SKILLS, RETIRED_SKILL_FILES } from "./pack-skills.js";
import { detectDeviations, recoverBase, GIT_BUDGET_MS, type Deviation, type ShippedStore } from "./pack-deviations.js";
import { pendingReconcile, readPending, writePending, pendingFile, type KeptEntry, type PendingEntry, type PendingRecord } from "./pack-updates.js";
import { carriedFrom, clearInputs, ensureGitignore, saveOverwritten, stageEntry, stagingDirRel, type CarriedBlock } from "./pack-staging.js";
import { parseSkillMarker, skillSha256 } from "./skill-marker.js";

/** Bump when the skill or either agent payload changes; covers the pack as one unit. */
export const OCTOBOTS_PACK_VERSION = 57;

export { OCTOBOTS_SKILLS };

/**
 * Files earlier pack versions installed that no longer exist. Removed on install, so an upgraded
 * workspace never keeps a script the skills no longer mention. Paths are relative to `.claude`.
 */
const RETIRED_FILES = [
  "skills/mission-planner/scripts/set-step.js",
  // Workflow support was removed (direct sub-agent dispatch replaced the Workflow tool). Only pack
  // files are listed: a user's `.octobots/**/workflows/` folders are data and are never touched.
  "skills/mission-planner/scripts/add-workflow.js",
  "skills/mission-planner/scripts/sync-meta.js",
  "skills/mission-planner/scripts/add-run.js",
  "skills/mission-planner/scripts/mission-input.js",
  "skills/mission-planner/scripts/extract-meta.mjs",
  "skills/mission-planner/scripts/workflow-meta.mjs",
  "skills/mission-planner/scripts/vendor/acorn.mjs",
] as const;

/** Skill ids an agent needs to drive Octobots. Today every agent needs the whole pack. */
export function requiredSkillsForAgent(_agent: string): string[] {
  return [...OCTOBOTS_SKILLS];
}

/** Read the `version:` integer from frontmatter; null if absent/unparseable. */
export function parseVersion(text: string): number | null {
  const m = text.match(/^version:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/**
 * Read the `// octobots-pack-version: N` marker from the primer script; null if absent.
 * Delegates to the shared rule (`pack-version-marker.ts`) — same marker, one spelling.
 */
export function parsePrimerVersion(text: string): number | null {
  return parsePackVersionMarker(text);
}

export interface PackStatus {
  /** All payloads are present. A `57-local` skill counts as present; a skill new in this pack version may be missing. */
  installed: boolean;
  currentVersion: number;
  /** Every skill is at the pack version with a stored hash or RECONCILED, and every other payload is current. */
  upToDate: boolean;
  /**
   * `upToDate`, except for deviations (pending, kept or unchosen) and newer skills. True whenever
   * `upToDate` is: what is left to install is nothing, or only what the user's own changes block.
   */
  upToDateExceptLocal: boolean;
  /** Skills whose SKILL.md differs from what the pack shipped, retired ones included. */
  deviations: Deviation[];
  /** Skills at `<N>+local` for this pack version, reconciled against the pack's current SKILL.md. */
  reconciled: string[];
  /** Skills staged for an agent to reconcile (`.octobots/pack-updates/pending.json`). */
  pendingReconcile: string[];
  /** Skills whose version is above the pack version. */
  newer: string[];
}

/** True when `store` lists `skill` at `version` and at no earlier version: the pack introduced it then. */
function isNewInVersion(store: ShippedStore | null, skill: string, version: number): boolean {
  if (!store || !store.versions[String(version)]?.[skill]) return false;
  return Object.entries(store.versions).every(([v, per]) => Number(v) >= version || !per[skill]);
}

/**
 * Inspect the installed pack: installed only if all payloads exist; up-to-date only if all match.
 * `store` is the shipped-skills store (`loadShippedStore`); without it SKILL.md content cannot be
 * checked, so an integer version up to the pack version is taken at its word.
 */
export function packStatus(repoRoot: string, currentVersion = OCTOBOTS_PACK_VERSION, store: ShippedStore | null = null): PackStatus {
  const primer = join(repoRoot, ".octobots", "hooks", "primer.mjs");
  const report = detectDeviations(repoRoot, currentVersion, store);
  const base = {
    currentVersion,
    deviations: report.deviations,
    reconciled: report.reconciled,
    pendingReconcile: pendingReconcile(repoRoot),
    newer: report.newer,
  };
  const notInstalled = { installed: false, upToDate: false, upToDateExceptLocal: false, ...base };

  // A missing skill that the pack introduced in this very version is "not yet installed", not a broken
  // install; any other missing skill is a broken install.
  const missingNew: string[] = [];
  const markers = new Map<string, ReturnType<typeof parseSkillMarker> | null>();
  for (const s of OCTOBOTS_SKILLS) {
    const file = join(repoRoot, ".claude", "skills", s, "SKILL.md");
    if (!existsSync(file)) {
      if (!isNewInVersion(store, s, currentVersion)) return notInstalled;
      missingNew.push(s);
      continue;
    }
    let m: ReturnType<typeof parseSkillMarker> | null;
    try { m = parseSkillMarker(readFileSync(file, "utf8")); } catch { m = null; }
    // `57-local` and `57+local` count as present; only a file with no version line is unreadable.
    if (m === null || m.kind === "none") return notInstalled;
    markers.set(s, m);
  }
  if (!existsSync(primer)) return notInstalled;
  let primerV: number | null;
  try { primerV = parsePrimerVersion(readFileSync(primer, "utf8")); } catch { primerV = null; }
  // Hooks being ABSENT is a legitimate choice (they are opt-in). Settings being UNREADABLE is not
  // the same thing: we cannot tell what is registered, so we must not let "absent" stand in for
  // "fine" and report the pack up-to-date on a file we failed to parse.
  let claude: { present: boolean; current: boolean };
  let claudeReadable = true;
  try { claude = claudeHookStatus(repoRoot, currentVersion); }
  catch { claude = { present: false, current: false }; claudeReadable = false; }
  // The tokenomics CLI is pack payload too: the mission gate is told to run it, so a pack without
  // it is incomplete, not merely missing an extra.
  const tokenomics = tokenomicsStatus(repoRoot, currentVersion);
  if (primerV === null || !tokenomics.present) return notInstalled;
  // Graph (octograph, M6) is opt-in via its own "Install Graph" command — a workspace that never
  // ran it must not be reported not-installed just because this optional payload is absent. Once
  // installed, though, staleness feeds the same `upToDate` verdict a stale skill/primer/tokenomics
  // already drives: one drift mechanism, not a second one bolted on beside it.
  // Hooks are opt-in too (see `installPack`), so their ABSENCE is a legitimate choice, not a broken
  // install — treating it as one would report a workspace that declined them as uninstalled forever
  // and re-prompt on every open. Once present, staleness feeds `upToDate` exactly as graph's does,
  // which is what lets an upgrade repair the duplicate entries older versions left behind.
  const graph = graphStatus(repoRoot, currentVersion);
  const otherPayloadsCurrent =
    primerV === currentVersion && claudeReadable && (!claude.present || claude.current) &&
    tokenomics.current && (!graph.present || graph.current);
  // A skill that is none of deviated, newer or reconciled is the pack's own file for SOME version:
  // current only when that version is this one (an older pristine file is stale, a pack matter).
  const local = new Set([...report.deviations.map((d) => d.skill), ...report.newer, ...report.reconciled]);
  const stale = [...markers].filter(([s, m]) => !local.has(s) && !(m?.kind === "integer" && m.n === currentVersion));
  const upToDateExceptLocal = otherPayloadsCurrent && stale.length === 0 && missingNew.length === 0;
  const upToDate = upToDateExceptLocal && report.deviations.length === 0 && report.newer.length === 0;
  return { installed: true, upToDate, upToDateExceptLocal, ...base };
}

/** Recursively copy a directory tree, counting files written. `skipRoot` names top-level files to leave alone. */
function copyTree(from: string, to: string, skipRoot: readonly string[] = []): number {
  let written = 0;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skipRoot.includes(entry.name)) continue;
    const f = join(from, entry.name);
    const t = join(to, entry.name);
    if (entry.isDirectory()) written += copyTree(f, t);
    else if (statSync(f).isFile()) { copyFileSync(f, t); written++; }
  }
  return written;
}

/** What an install does with a pack skill whose SKILL.md was changed in the workspace. */
export type LocalChanges = "reconcile" | "overwrite" | "keep";

export interface InstallOptions {
  hooks?: boolean;
  statusline?: boolean;
  tools?: boolean;
  /**
   * `reconcile` (default; also what any non-interactive install records) keeps each changed SKILL.md and
   * stages it for an agent; `overwrite` saves it as overwritten-local.md and replaces it (a retired
   * skill is deleted); `keep` leaves it and records that. Only SKILL.md is ever protected.
   */
  localChanges?: LocalChanges;
  /**
   * The shipped-skill store (`loadShippedStore`), or null when it is missing or unreadable. Without
   * it a changed SKILL.md cannot be told from the pack's own, so the install writes nothing.
   */
  store: ShippedStore | null;
  /** Overrides the pack version for detection and staging (QA only: exercises a later version). */
  packVersion?: number;
}

export interface InstallResult {
  written: number;
  hooksRegistered: boolean;
  statusline: "registered" | "foreign" | "skipped";
  tools: "installed" | "failed" | "skipped";
  /** Skills staged for an agent to reconcile. */
  pending: string[];
  /** Skills the user chose to keep as they are. */
  kept: string[];
  /** Files in a retired skill's directory that the pack never shipped; left in place. Workspace-relative, with `/`. */
  keptFiles: string[];
  /** Set when nothing was installed, and why. */
  error?: string;
}

export const STORE_MISSING = "shipped-skill store missing";

const skillDirOf = (repoRoot: string, name: string): string => join(repoRoot, ".claude", "skills", name);

/** Removes empty directories under `dir` (and `dir` itself) bottom-up. */
function pruneEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Every file left under `dir`, relative to `base`, with `/`. */
function filesUnder(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base));
    else out.push(p.slice(base.length + 1).split(/[\\/]/).join("/"));
  }
  return out;
}

/** Removes the files the pack shipped for a retired skill; returns the files it left because it never shipped them. */
function removeRetiredSkill(repoRoot: string, name: (typeof RETIRED_SKILLS)[number]): string[] {
  const dir = skillDirOf(repoRoot, name);
  if (!existsSync(dir)) return [];
  for (const rel of RETIRED_SKILL_FILES[name]) rmSync(join(dir, ...rel.split("/")), { force: true });
  pruneEmpty(dir);
  return existsSync(dir) ? filesUnder(dir, repoRoot) : [];
}

/**
 * Install the pack from `srcRoot` (the resources/octobots-pack dir) into <repoRoot>:
 * each skill → .claude/skills/<name>, the session primer and its Claude hook, and the tokenomics
 * CLI → .octobots/tokenomics. Skill dirs retired by a rename are removed first, so an upgrade never
 * leaves two copies on disk. The graph payload (`.claude/skills/graph/octograph.mjs`) is refreshed
 * here too, but only when already present — see `graphStatus`'s doc comment for why it's opt-in.
 *
 * A skill whose SKILL.md the workspace changed is handled per `opts.localChanges` (see
 * `InstallOptions`). Only SKILL.md is protected: the rest of that skill's directory installs as for
 * any skill, `RETIRED_FILES` inside it are removed and files the pack never shipped are kept. A
 * retired skill's directory loses only the files the pack shipped; the rest is kept and reported.
 *
 * The pack installs **no agents**. Planning and execution run under whatever agent the user is
 * already in, driven by the skills; agent rosters belong to the repo, not to us.
 */
export function installPack(srcRoot: string, repoRoot: string, opts: InstallOptions): InstallResult {
  const { store } = opts;
  if (!store) {
    return { written: 0, hooksRegistered: false, statusline: "skipped", tools: "skipped", pending: [], kept: [], keptFiles: [], error: STORE_MISSING };
  }
  const packVersion = opts.packVersion ?? OCTOBOTS_PACK_VERSION;
  const choice: LocalChanges = opts.localChanges ?? "reconcile";
  // Rule-2 base recovery runs git synchronously, so the whole install shares ONE deadline: it blocks
  // the extension host for GIT_BUDGET_MS at most, however many skills are deviated.
  const gitDeadline = Date.now() + GIT_BUDGET_MS;

  const currentHashes: Record<string, string> = {};
  for (const name of OCTOBOTS_SKILLS) {
    const f = join(srcRoot, "skill", name, "SKILL.md");
    if (existsSync(f)) currentHashes[name] = skillSha256(readFileSync(f, "utf8"));
  }
  const report = detectDeviations(repoRoot, packVersion, store, { currentHashes });
  const prior = readPending(repoRoot);
  const priorEntry = (skill: string): PendingEntry | undefined => prior?.skills.find((e) => e.skill === skill);
  const priorVersion = (e: PendingEntry): number => Number(e.dir.match(/\/v(\d+)\//)?.[1] ?? prior?.packVersion ?? packVersion);
  const localBytes = new Map<string, Buffer>(report.deviations.map((d) => [d.skill, readFileSync(join(skillDirOf(repoRoot, d.skill), "SKILL.md"))]));

  // Decide, before writing anything, what to stage: an entry that is unchanged is reused untouched.
  interface Plan { dev: Deviation; reuse: PendingEntry | null; base: ReturnType<typeof recoverBase>; upstream: Buffer | null; carried: CarriedBlock[]; replacedDir?: string }
  const plans: Plan[] = [];
  if (choice === "reconcile") {
    for (const dev of report.deviations) {
      const dirRel = stagingDirRel(packVersion, dev.skill);
      const upstreamSha = dev.retired ? null : (currentHashes[dev.skill] ?? null);
      const old = priorEntry(dev.skill);
      const unchanged = old !== undefined && old.dir === dirRel && old.localSha256 === dev.sha256 && old.localVersion === dev.version &&
        old.retired === dev.retired && old.upstreamSha256 === upstreamSha && prior?.packVersion === packVersion &&
        existsSync(join(repoRoot, ...dirRel.split("/"), "local.md")) && existsSync(join(repoRoot, ...dirRel.split("/"), "RECONCILE.md"));
      if (unchanged) { plans.push({ dev, reuse: old, base: null, upstream: null, carried: [] }); continue; }
      const upstreamFile = join(srcRoot, "skill", dev.skill, "SKILL.md");
      plans.push({
        dev,
        reuse: null,
        base: recoverBase(repoRoot, dev.skill, localBytes.get(dev.skill)!, packVersion, store, { gitDeadline }),
        upstream: dev.retired ? null : readFileSync(upstreamFile),
        carried: carriedFrom(repoRoot, old, old ? priorVersion(old) : packVersion),
        ...(old ? { replacedDir: old.dir } : {}),
      });
    }
  }

  const deviated = new Set(report.deviations.map((d) => d.skill));
  const replaced = new Set(choice === "overwrite" ? deviated : []);
  // Overwrite saves what it replaces FIRST: if that fails, nothing else has been touched.
  for (const dev of report.deviations) {
    if (replaced.has(dev.skill)) saveOverwritten(repoRoot, packVersion, dev.skill, localBytes.get(dev.skill)!);
  }

  let written = 0;
  const keptFiles: string[] = [];
  const left = new Set([...deviated, ...report.newer]); // a retired skill left whole: changed, or newer than the pack
  for (const name of RETIRED_SKILLS) {
    if (left.has(name) && !replaced.has(name)) continue;
    keptFiles.push(...removeRetiredSkill(repoRoot, name));
  }
  for (const rel of RETIRED_FILES) {
    rmSync(join(repoRoot, ".claude", rel), { force: true });
  }
  // SKILL.md of a changed skill (kept or being reconciled) and of a reconciled one is protected; a
  // skill newer than the pack is not touched at all.
  const protectedSkills = new Set<string>([...report.reconciled, ...[...deviated].filter((s) => !replaced.has(s))]);
  for (const name of OCTOBOTS_SKILLS) {
    if (report.newer.includes(name)) continue;
    written += copyTree(
      join(srcRoot, "skill", name),
      skillDirOf(repoRoot, name),
      protectedSkills.has(name) ? ["SKILL.md"] : [],
    );
  }

  // The pending record: one entry per skill, rebuilt from this install's results.
  const skills: PendingEntry[] = [];
  const kept: KeptEntry[] = [];
  const staged: string[] = [];
  for (const plan of plans) {
    const { dev } = plan;
    if (plan.reuse) { skills.push(plan.reuse); staged.push(dev.skill); continue; }
    skills.push(stageEntry({
      repoRoot, skill: dev.skill, packVersion, retired: dev.retired, localVersion: dev.version, localSha256: dev.sha256,
      base: plan.base, upstreamSha256: dev.retired ? null : (currentHashes[dev.skill] ?? null), carried: plan.carried,
      localBytes: localBytes.get(dev.skill)!, upstreamBytes: plan.upstream,
      ...(plan.replacedDir ? { replacedDir: plan.replacedDir } : {}), restage: priorEntry(dev.skill) !== undefined,
    }));
    staged.push(dev.skill);
  }
  if (choice !== "reconcile") {
    for (const dev of report.deviations) {
      // Inputs of the entry (and of this version's folder) go; logs and saved local files stay.
      const old = priorEntry(dev.skill);
      if (old) clearInputs(repoRoot, old.dir);
      clearInputs(repoRoot, stagingDirRel(packVersion, dev.skill));
      if (choice === "keep") kept.push({ skill: dev.skill, packVersion, sha256: dev.sha256 });
    }
  }
  // Keep pending.json current once there is anything to record, or a record to bring up to date
  // (a malformed one is replaced from these results). A workspace that never had a changed skill
  // gets no `.octobots/pack-updates/` at all.
  if (skills.length > 0 || kept.length > 0 || existsSync(pendingFile(repoRoot))) {
    const rec: PendingRecord = { packVersion, skills, kept };
    writePending(repoRoot, rec);
  }
  if (existsSync(join(repoRoot, ".octobots", "pack-updates"))) ensureGitignore(repoRoot);

  written += installPrimer(srcRoot, repoRoot);
  written += installTokenomics(srcRoot, repoRoot);
  // Graph is opt-in (see `graphStatus`'s doc comment): a general pack (re)install only refreshes
  // an already-present graph payload, so re-running this after an upgrade is what clears the
  // staleness `packStatus` flagged — without silently installing graph into a workspace that
  // never asked for it via "Octobots: Install Graph".
  if (graphStatus(repoRoot, OCTOBOTS_PACK_VERSION).present) {
    written += installGraph(srcRoot, repoRoot);
  }
  // Hooks are OPT-IN, on the same doctrine as graph above: they run on every session start and
  // after every Bash tool call, so installing them into a workspace that never asked for them
  // changes how that repo's agents behave — and costs a process per tool call. `opts.hooks === true`
  // is an explicit yes; otherwise we only REFRESH hooks that are already registered, which is what
  // keeps upgrades (and the duplicate-entry repair in `registerClaudeHook`) working without ever
  // adding them behind the user's back. `opts.hooks === false` is a deliberate no — it clears ours.
  const already = claudeHookStatus(repoRoot, OCTOBOTS_PACK_VERSION).present;
  let hooksRegistered = false;
  if (opts.hooks === false) {
    unregisterClaudeHook(repoRoot);
  } else if (opts.hooks === true || already) {
    registerClaudeHook(repoRoot, OCTOBOTS_PACK_VERSION);
    hooksRegistered = true;
  }
  // The status line follows the hooks rule exactly — opt-in, refresh-if-present — with one addition:
  // `statusLine` holds a SINGLE entry, so registering ours over a status line we did not write would
  // delete it irrecoverably. `registerStatusline` refuses that case and reports `foreign` instead.
  const slBefore = statuslineStatus(repoRoot, OCTOBOTS_PACK_VERSION);
  let statusline: "registered" | "foreign" | "skipped" = "skipped";
  if (opts.statusline === false) {
    unregisterStatusline(repoRoot);
  } else if (opts.statusline === true || slBefore.registered) {
    written += installStatusline(srcRoot, repoRoot);
    statusline = registerStatusline(repoRoot);
  }
  // `.octobots/tools` follows the same tri-state, with one difference that earns its own note: this
  // is the ONLY pack step that needs the network, so it is never attempted without an explicit yes,
  // and a failure is reported rather than raised — tokenomics still works via `npx`, just slowly.
  let tools: "installed" | "failed" | "skipped" = "skipped";
  if (opts.tools === false) {
    removeTools(repoRoot);
  } else if (opts.tools === true || toolsStatus(repoRoot).ccusage) {
    tools = installTools(repoRoot) ? "installed" : "failed";
  }
  return { written, hooksRegistered, statusline, tools, pending: staged, kept: kept.map((k) => k.skill), keptFiles };
}
