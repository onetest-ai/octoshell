import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCampaign, createMission, createTask } from "@octoshell/board";
import { mkdtempClean } from "./tmpdir.js";

/** The real script the hooks watch. Hooks must resolve its target exactly the way it does. */
export const SET_STATUS = join(__dirname, "..", "..", "resources", "octobots-pack", "skill", "mission-planner", "scripts", "set-status.js");

export interface StatusBoard {
  /** Repo root (CLAUDE_PROJECT_DIR); the board lives in `<repo>/.octobots`. */
  repo: string;
  /** Absolute campaign dir: the `<parent-dir>` for a mission flip. */
  campaignDir: string;
  /** Absolute mission dir (title "M1 - Venue ingest"): the `<parent-dir>` for a task flip. */
  missionDir: string;
}

/** A real board in a temp repo: campaign C, mission "M1 - Venue ingest", task "T1.1 - Parse ids". */
export function makeStatusBoard(prefix: string): StatusBoard {
  const repo = mkdtempClean(prefix);
  const boardRoot = join(repo, ".octobots");
  mkdirSync(boardRoot, { recursive: true });
  const c = createCampaign(boardRoot, { name: "C" });
  const m = createMission(boardRoot, c.id, { title: "M1 - Venue ingest", acceptanceCriteria: "- [ ] a" });
  createTask(boardRoot, m.id, { name: "T1.1 - Parse ids", acceptanceCriteria: "- [ ] b" });
  return { repo, campaignDir: join(boardRoot, c.folderPath), missionDir: join(boardRoot, m.folderPath) };
}

/** The Bash command an agent would run, e.g. `node …/set-status.js "<dir>" "M1 - …" done`. */
export function setStatusCommand(parentDir: string, title: string, state: string, suffix = ""): string {
  return `node "${SET_STATUS}" "${parentDir}" "${title}" ${state}${suffix}`;
}

/** The PostToolUse JSON Claude Code pipes into a hook for that Bash command. */
export function postToolUse(repo: string, command: string, sessionId = "sess-abc"): Record<string, unknown> {
  return { tool_name: "Bash", session_id: sessionId, cwd: repo, tool_input: { command } };
}

/** Actually run the command (as the shell would) so the board changes, and return its payload. */
export function runAndPost(repo: string, command: string): Record<string, unknown> {
  spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf8" });
  return postToolUse(repo, command);
}
