import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Copy the pack's hooks/ payload (primer.mjs + package.json) into <repo>/.octobots/hooks. */
export function installPrimer(srcRoot: string, repoRoot: string): number {
  const from = join(srcRoot, "hooks");
  const to = join(repoRoot, ".octobots", "hooks");
  mkdirSync(to, { recursive: true });
  let written = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(from, entry.name), join(to, entry.name));
    written++;
  }
  return written;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err; // malformed JSON — do not silently discard the user's settings
  }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string; async?: boolean }[]; _octobots?: number };

const CLAUDE_CMD = `node "\${CLAUDE_PROJECT_DIR}/.octobots/hooks/primer.mjs" --backend claude`;
const WORK_LOG_CMD = `node "\${CLAUDE_PROJECT_DIR}/.octobots/hooks/work-log.mjs"`;
const MISSION_GATE_CMD = `node "\${CLAUDE_PROJECT_DIR}/.octobots/hooks/mission-gate.mjs"`;

/** The Claude hook events we own. Every entry we write carries `_octobots`. */
const CLAUDE_EVENTS = ["SessionStart", "PreCompact", "PostToolUse"] as const;
type ClaudeEvent = (typeof CLAUDE_EVENTS)[number];

function claudeEntries(event: ClaudeEvent, version: number): HookEntry[] {
  if (event === "PostToolUse") {
    return [
      // The work log records which session did which task, so tokenomics
      // attribution is a recorded fact rather than an inference from branch
      // names. Async: nothing downstream waits on it, and it must never delay
      // or fail the tool call.
      { matcher: "Bash", hooks: [{ type: "command", command: WORK_LOG_CMD, async: true }], _octobots: version },
      // The mission gate steers the agent into the blocking completion gate
      // when a mission flips to `done`. Synchronous *by design* — it injects a
      // directive the orchestrator must act on before proceeding, which an
      // async hook could not do.
      { matcher: "Bash", hooks: [{ type: "command", command: MISSION_GATE_CMD, async: false }], _octobots: version },
    ];
  }
  const entry: HookEntry = { hooks: [{ type: "command", command: CLAUDE_CMD, async: false }], _octobots: version };
  if (event === "SessionStart") entry.matcher = "startup|clear|compact|resume";
  return [entry];
}

/**
 * The scripts we own, by path fragment. An entry running one of these is OURS whether or not it
 * carries the `_octobots` marker — which is what makes re-registration idempotent against entries
 * written before the marker existed (or copied in by hand).
 *
 * Recognising ours by marker ALONE was a duplication bug: an unmarked entry survived the filter,
 * a marked twin was appended beside it, and every subsequent install re-created the pair. Observed
 * in the field on a real board — primer.mjs registered twice on SessionStart and twice on
 * PreCompact, work-log.mjs and mission-gate.mjs twice each on PostToolUse — so every Bash tool call
 * paid four hook processes instead of two, forever, with no way to clear it by reinstalling.
 */
const OUR_SCRIPTS = [
  ".octobots/hooks/primer.mjs",
  ".octobots/hooks/work-log.mjs",
  ".octobots/hooks/mission-gate.mjs",
] as const;

/** True when this entry is one of ours — by marker, or by the script its command runs. */
function isOurs(entry: HookEntry): boolean {
  if (entry._octobots !== undefined) return true;
  return (entry.hooks ?? []).some((h) => OUR_SCRIPTS.some((s) => (h.command ?? "").includes(s)));
}

/** Idempotently merge our SessionStart + PreCompact + PostToolUse entries into <repo>/.claude/settings.json. */
export function registerClaudeHook(repoRoot: string, version: number): void {
  const path = join(repoRoot, ".claude", "settings.json");
  const settings = readJson(path);
  const hooks = (settings.hooks ??= {}) as Record<string, HookEntry[]>;
  for (const event of CLAUDE_EVENTS) {
    const arr = (hooks[event] ?? []).filter((e) => !isOurs(e)); // drop our prior entries, marked or not
    arr.push(...claudeEntries(event, version));
    hooks[event] = arr;
  }
  writeJson(path, settings);
}

/**
 * Remove every entry we own from <repo>/.claude/settings.json, leaving other tools' hooks alone.
 * Returns how many entries were dropped. Used by the install prompt's "no" path, so declining
 * hooks on an upgrade actually clears the ones an earlier version installed silently.
 */
export function unregisterClaudeHook(repoRoot: string): number {
  const path = join(repoRoot, ".claude", "settings.json");
  const settings = readJson(path);
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  let dropped = 0;
  for (const event of CLAUDE_EVENTS) {
    const before = hooks[event] ?? [];
    const after = before.filter((e) => !isOurs(e));
    dropped += before.length - after.length;
    if (after.length) hooks[event] = after;
    else delete hooks[event];
  }
  if (dropped) writeJson(path, settings);
  return dropped;
}

/** Whether our Claude hook entries are present, and whether they match `version`. */
export function claudeHookStatus(repoRoot: string, version: number): { present: boolean; current: boolean } {
  const settings = readJson(join(repoRoot, ".claude", "settings.json"));
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  // `isOurs`, not the marker alone: an unmarked entry still RUNS our hook, so a workspace carrying
  // only unmarked ones is `present` but not `current` — which routes it into the upgrade prompt,
  // where re-registering replaces the pair with a single marked entry.
  const ours = (event: string) => (hooks[event] ?? []).filter(isOurs);
  const mine = CLAUDE_EVENTS.map(ours);
  // Every event we own must be present. An install predating an added event
  // reports `present: false`, so re-running the installer repairs it rather
  // than reporting a partial install as healthy.
  const present = mine.every((entries) => entries.length > 0);
  const current = present && mine.flat().every((e) => e._octobots === version);
  return { present, current };
}

