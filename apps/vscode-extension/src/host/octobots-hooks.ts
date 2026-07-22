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

/** Idempotently merge our SessionStart + PreCompact + PostToolUse entries into <repo>/.claude/settings.json. */
export function registerClaudeHook(repoRoot: string, version: number): void {
  const path = join(repoRoot, ".claude", "settings.json");
  const settings = readJson(path);
  const hooks = (settings.hooks ??= {}) as Record<string, HookEntry[]>;
  for (const event of CLAUDE_EVENTS) {
    const arr = (hooks[event] ?? []).filter((e) => e._octobots === undefined); // drop our prior entries
    arr.push(...claudeEntries(event, version));
    hooks[event] = arr;
  }
  writeJson(path, settings);
}

/** Whether our Claude hook entries are present, and whether they match `version`. */
export function claudeHookStatus(repoRoot: string, version: number): { present: boolean; current: boolean } {
  const settings = readJson(join(repoRoot, ".claude", "settings.json"));
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const ours = (event: string) => (hooks[event] ?? []).filter((e) => e._octobots !== undefined);
  const mine = CLAUDE_EVENTS.map(ours);
  // Every event we own must be present. An install predating an added event
  // reports `present: false`, so re-running the installer repairs it rather
  // than reporting a partial install as healthy.
  const present = mine.every((entries) => entries.length > 0);
  const current = present && mine.flat().every((e) => e._octobots === version);
  return { present, current };
}

