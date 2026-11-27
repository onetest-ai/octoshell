import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBug, createCampaign, createMission, createTask } from "@octoshell/board";
import { mkdtempClean } from "./tmpdir.js";

/** The real script the hooks watch. Hooks must resolve its target exactly the way it does. */
export const SET_STATUS = join(__dirname, "..", "..", "resources", "octobots-pack", "skill", "mission-planner", "scripts", "set-status.js");

export interface StatusBoard {
  /** Repo root (CLAUDE_PROJECT_DIR); the board lives in `<repo>/.octobots`. */
  repo: string;
  /** The campaign's board id. */
  campaignId: string;
  /** Absolute campaign dir: the `<parent-dir>` for a mission flip. */
  campaignDir: string;
  /** The mission's board id. */
  missionId: string;
  /** Absolute mission dir (title "M1 - Venue ingest"): the `<parent-dir>` for a task flip. */
  missionDir: string;
}

/** Install mission-planner's scripts where installPack puts them: `<repo>/.claude/skills/mission-planner/scripts`. */
export function installPlannerScripts(repo: string): string {
  const to = join(repo, ".claude", "skills", "mission-planner", "scripts");
  cpSync(dirname(SET_STATUS), to, { recursive: true });
  return join(to, "set-status.js");
}

/**
 * A real board in a temp repo: campaign C, mission "M1 - Venue ingest", task "T1.1 - Parse ids", with
 * the pack's mission-planner scripts installed (the hooks load their resolver from there and only
 * there). Pass `{ install: false }` for a board whose pack is not installed.
 */
export function makeStatusBoard(prefix: string, opts: { install?: boolean } = {}): StatusBoard {
  const repo = mkdtempClean(prefix);
  if (opts.install !== false) installPlannerScripts(repo);
  const boardRoot = join(repo, ".octobots");
  mkdirSync(boardRoot, { recursive: true });
  const c = createCampaign(boardRoot, { name: "C" });
  const m = createMission(boardRoot, c.id, { title: "M1 - Venue ingest", acceptanceCriteria: "- [ ] a" });
  createTask(boardRoot, m.id, { name: "T1.1 - Parse ids", acceptanceCriteria: "- [ ] b" });
  return { repo, campaignId: c.id, campaignDir: join(boardRoot, c.folderPath), missionId: m.id, missionDir: join(boardRoot, m.folderPath) };
}

/** Add a mission with an arbitrary title (quotes, `;`, `&&`) to the board's campaign. */
export function createMissionNamed(b: StatusBoard, title: string): void {
  createMission(join(b.repo, ".octobots"), b.campaignId, { title, acceptanceCriteria: "- [ ] a" });
}

/** Add a task with an arbitrary name under the board's mission. */
export function createTaskNamed(b: StatusBoard, title: string): void {
  createTask(join(b.repo, ".octobots"), b.missionId, { name: title, acceptanceCriteria: "- [ ] b" });
}

/**
 * Add a bug with an arbitrary title under the mission (`on: "mission"`, the default) or the campaign.
 * Bugs are often titled after the task or mission they were found in ("T1.1 review nits"), which is
 * exactly what the hooks must not mistake for that task or mission.
 */
export function createBugNamed(b: StatusBoard, title: string, on: "mission" | "campaign" = "mission"): void {
  createBug(join(b.repo, ".octobots"), on === "campaign" ? { campaignId: b.campaignId } : { missionId: b.missionId }, { title });
}

/** The Bash command an agent would run, e.g. `node …/set-status.js "<dir>" "M1 - …" done`. */
export function setStatusCommand(parentDir: string, title: string, state: string, suffix = ""): string {
  return `node "${SET_STATUS}" "${parentDir}" "${title}" ${state}${suffix}`;
}

/** The PostToolUse JSON Claude Code pipes into a hook for that Bash command (no tool_response). */
export function postToolUse(repo: string, command: string, sessionId = "sess-abc"): Record<string, unknown> {
  return { tool_name: "Bash", session_id: sessionId, cwd: repo, tool_input: { command } };
}

/** The same payload as a harness sends it after the command ran: `tool_response` carries stdout/stderr. */
export function postToolUseWithOutput(repo: string, command: string, stdout: string, sessionId = "sess-abc"): Record<string, unknown> {
  return { ...postToolUse(repo, command, sessionId), tool_response: { stdout, stderr: "", interrupted: false, isImage: false } };
}

/** Actually run the command (as the shell would) so the board changes, and return its real payload incl. stdout. */
export function runAndPost(repo: string, command: string): Record<string, unknown> {
  // set-status.js records the work log itself under CLAUDE_CODE_SESSION_ID: a developer running this suite
  // inside a Claude Code session must not leak theirs into these runs.
  const { CLAUDE_CODE_SESSION_ID: _session, ...env } = process.env;
  const r = spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf8", env });
  return {
    ...postToolUse(repo, command),
    tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false },
  };
}

/**
 * A copy of the pack's hooks directory whose status-flip.mjs is "older": confirmedTransitions returns
 * its calls without `kind`, like a workspace that kept a local copy from before the hooks relied on it.
 */
export function hooksWithOldStatusFlip(): string {
  const dir = join(mkdtempClean("octo-old-flip-"), "hooks");
  cpSync(join(__dirname, "..", "..", "resources", "octobots-pack", "hooks"), dir, { recursive: true });
  const file = join(dir, "status-flip.mjs");
  const src = readFileSync(file, "utf8");
  const old = src.replace("out.push({ ...call, kind });", "out.push({ ...call });");
  if (old === src) throw new Error("status-flip.mjs no longer has the kind push this fixture strips");
  writeFileSync(file, old);
  return dir;
}
