import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Copy the pack's hooks/ payload into <repo>/.octobots/hooks, except the file names in `keep` (local changes and special files). */
export function installPrimer(srcRoot: string, repoRoot: string, keep: ReadonlySet<string> = new Set()): number {
  const from = join(srcRoot, "hooks");
  const to = join(repoRoot, ".octobots", "hooks");
  mkdirSync(to, { recursive: true });
  let written = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || keep.has(entry.name)) continue;
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

/**
 * The hook entries octoshell owns, as data: the single source for what the installer writes
 * (`claudeEntries`), for which scripts count as ours (`OUR_SCRIPTS`), and for the default list the pack
 * doctor checks (`resources/octobots-pack/hooks/required-hooks.json`, derived by `octoshellRequiredHooks`
 * and pinned by a test). `args` is the command-line tail the installer appends; `async: false` means
 * the hook injects something the agent must see before it proceeds.
 */
export const OCTOBOTS_HOOK_SPECS = [
  { event: "SessionStart", script: ".octobots/hooks/primer.mjs", args: "--backend claude", matcher: "startup|clear|compact|resume", async: false },
  // The work log records which session did which task, so tokenomics attribution is a recorded fact
  // rather than an inference from branch names. Async: nothing downstream waits on it, and it must
  // never delay or fail the tool call.
  { event: "PostToolUse", script: ".octobots/hooks/work-log.mjs", matcher: "Bash", async: true },
  { event: "PreToolUse", script: ".octobots/hooks/dispatch-on-main.mjs", matcher: "Agent|Task", async: true },
] as const satisfies readonly { event: string; script: string; args?: string; matcher: string; async: boolean }[];

/** The Claude hook events we own. Every entry we write carries `_octobots`. */
const CLAUDE_EVENTS = ["SessionStart", "PostToolUse", "PreToolUse"] as const;
type ClaudeEvent = (typeof CLAUDE_EVENTS)[number];

const commandOf = (spec: (typeof OCTOBOTS_HOOK_SPECS)[number]): string =>
  `node "\${CLAUDE_PROJECT_DIR}/${spec.script}"${"args" in spec ? ` ${spec.args}` : ""}`;

/** The installer command the pack doctor prints for a missing octoshell entry. */
const INSTALLER_COMMAND = 'VS Code command palette: "Octobots: Install Octobots Pack" (current Octobots extension)';

/** The pack doctor's default required list, in its file schema (version, installers, hooks). */
export function octoshellRequiredHooks(): Record<string, unknown> {
  return {
    version: 1,
    note: "Octoshell's own hook entries, derived from OCTOBOTS_HOOK_SPECS in octobots-hooks.ts (the installer's own list). Matched by script path and matcher in .claude/settings.json, never by command string. A repo adds other installers' entries in .agents/settings/required-hooks.json (add-only).",
    installers: {
      octoshell: { source: "octoshell apps/vscode-extension/src/host/octobots-hooks.ts", command: INSTALLER_COMMAND },
    },
    hooks: OCTOBOTS_HOOK_SPECS.map((s) => ({
      event: s.event,
      script: s.script,
      matcher: s.matcher,
      owner: "octoshell",
      ...(s.async ? {} : { sync: true }),
    })),
  };
}

/**
 * Events an earlier pack registered and this one no longer does. Our entries there are stripped on
 * every register/unregister, and a leftover one makes the install report as not current, so the
 * upgrade prompt repairs it.
 *
 * PreCompact: Claude Code rejects `hookSpecificOutput` on PreCompact ("Hook JSON output validation
 * failed"), so the primer failed visibly on every compaction and its text was dropped. It was also
 * redundant: SessionStart's `compact` matcher re-injects the primer after a compaction.
 */
const RETIRED_CLAUDE_EVENTS = ["PreCompact"] as const;

function claudeEntries(event: ClaudeEvent, version: number): HookEntry[] {
  return OCTOBOTS_HOOK_SPECS.filter((spec) => spec.event === event).map((spec) => ({
    matcher: spec.matcher,
    hooks: [{ type: "command", command: commandOf(spec), async: spec.async }],
    _octobots: version,
  }));
}

/**
 * The scripts we own, by path fragment. An entry running one of these is OURS whether or not it
 * carries the `_octobots` marker — which is what makes re-registration idempotent against entries
 * written before the marker existed (or copied in by hand).
 *
 * Recognising ours by marker ALONE was a duplication bug: an unmarked entry survived the filter,
 * a marked twin was appended beside it, and every subsequent install re-created the pair. Observed
 * in the field on a real board — primer.mjs registered twice on SessionStart and twice on
 * PreCompact, work-log.mjs twice on PostToolUse — so every Bash tool call
 * paid four hook processes instead of two, forever, with no way to clear it by reinstalling.
 */
const OUR_SCRIPTS: readonly string[] = OCTOBOTS_HOOK_SPECS.map((spec) => spec.script);

/**
 * Hook scripts an older pack registered and this one no longer ships. `isOurs` still recognises
 * them, so re-registration drops an old unmarked entry instead of leaving it to fail on every call.
 */
const RETIRED_HOOK_SCRIPTS: readonly string[] = [".octobots/hooks/mission-gate.mjs"];

/** True when this entry is one of ours — by marker, or by the script its command runs. */
function isOurs(entry: HookEntry): boolean {
  if (entry._octobots !== undefined) return true;
  const known = [...OUR_SCRIPTS, ...RETIRED_HOOK_SCRIPTS];
  return (entry.hooks ?? []).some((h) => known.some((s) => (h.command ?? "").includes(s)));
}

/** Idempotently merge our SessionStart + PostToolUse entries into <repo>/.claude/settings.json. */
export function registerClaudeHook(repoRoot: string, version: number): void {
  const path = join(repoRoot, ".claude", "settings.json");
  const settings = readJson(path);
  const hooks = (settings.hooks ??= {}) as Record<string, HookEntry[]>;
  for (const event of CLAUDE_EVENTS) {
    const arr = (hooks[event] ?? []).filter((e) => !isOurs(e)); // drop our prior entries, marked or not
    arr.push(...claudeEntries(event, version));
    hooks[event] = arr;
  }
  dropOursFrom(hooks, RETIRED_CLAUDE_EVENTS);
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
  const dropped = dropOursFrom(hooks, [...CLAUDE_EVENTS, ...RETIRED_CLAUDE_EVENTS]);
  if (dropped) writeJson(path, settings);
  return dropped;
}

/** Remove our entries from `events`, deleting an event left empty. Returns how many were dropped. */
function dropOursFrom(hooks: Record<string, HookEntry[]>, events: readonly string[]): number {
  let dropped = 0;
  for (const event of events) {
    const before = hooks[event];
    if (!before) continue;
    const after = before.filter((e) => !isOurs(e));
    dropped += before.length - after.length;
    if (after.length) hooks[event] = after;
    else delete hooks[event];
  }
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
  const leftover = RETIRED_CLAUDE_EVENTS.some((event) => ours(event).length > 0);
  const scriptsMatch = CLAUDE_EVENTS.every((event) => claudeEntries(event, version).every((expected) =>
    (hooks[event] ?? []).some((entry) => entry.matcher === expected.matcher &&
      expected.hooks.every((h) => entry.hooks.some((actual) => actual.command === h.command)))));
  const current = present && !leftover && scriptsMatch && mine.flat().every((e) => e._octobots === version);
  return { present, current };
}


/** A previous opt-in remains installed even when this pack adds another required event. */
export function claudeHooksRegistered(repoRoot: string): boolean {
  const settings = readJson(join(repoRoot, ".claude", "settings.json"));
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  return [...CLAUDE_EVENTS, ...RETIRED_CLAUDE_EVENTS].some((event) => (hooks[event] ?? []).some(isOurs));
}
