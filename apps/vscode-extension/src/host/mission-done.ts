import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BoardHost } from "./board-host.js";
import { parsePrimerVersion } from "./octobots-skill.js";

export type MissionDoneResult = { ok: true } | { ok: false; message: string };

export interface MissionDoneOpts {
  board: BoardHost;
  workspaceFolderPath: string;
  scriptPath: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
}

/** The pack version that introduced the mission-done guard in set-status.js. */
const GUARD_PACK_VERSION = 65;

/** True when the workspace's installed primer is at the pack version that ships the guard. */
export function missionGuardApplies(workspaceFolderPath: string): boolean {
  try {
    const text = readFileSync(join(workspaceFolderPath, ".octobots", "hooks", "primer.mjs"), "utf8");
    const v = parsePrimerVersion(text);
    return v !== null && v >= GUARD_PACK_VERSION;
  } catch {
    return false;
  }
}

/**
 * Mark a mission done through the pack's set-status.js, so the completion gate is enforced exactly
 * as it is for agents. Exit 3 is the gate's refusal; any other failure is an error.
 */
export function runMissionDone(opts: MissionDoneOpts, missionId: string, force?: string): Promise<MissionDoneResult> {
  const mission = opts.board.getMission(missionId);
  if (!mission) throw new Error(`mission not found: ${missionId}`);
  // Target the mission's own folder (absolute): the script resolves the folder's own entity ("self")
  // first, so a campaign or sibling mission with the same title can never be picked instead, and a
  // legacy mission.md mission resolves as well as a mission.yaml one.
  const missionDir = resolve(opts.board.artifactsRoot, mission.folderPath);
  const args = [opts.scriptPath, missionDir, mission.title, "done", ...(force ? [`--force=${force}`] : [])];
  return new Promise((resolvePromise, reject) => {
    execFile(
      opts.nodePath,
      args,
      { cwd: opts.workspaceFolderPath, env: opts.env, timeout: 60000 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!err) {
          try {
            opts.board.reconcile();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          resolvePromise({ ok: true });
        } else if ((err as { code?: unknown }).code === 3) {
          resolvePromise({ ok: false, message: output });
        } else {
          reject(new Error(output.trim() || err.message));
        }
      },
    );
  });
}
