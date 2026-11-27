import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BoardHost } from "../src/host/board-host.js";
import { runMissionDone, missionGuardApplies } from "../src/host/mission-done.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const scriptPath = resolve(__dirname, "../resources/octobots-pack/skill/mission-planner/scripts/set-status.js");

function setup() {
  const repoRoot = mkdtempClean("mission-done-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoRoot, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  const board = new BoardHost(join(repoRoot, ".octobots"));
  const camp = board.createCampaign({ name: "Camp" });
  const mission = board.createMission({ title: "Mish", campaignId: camp.id });
  git("add", "-A");
  git("commit", "-qm", "init", "--allow-empty");
  const opts = { board, workspaceFolderPath: repoRoot, scriptPath, nodePath: process.execPath, env: process.env };
  return { repoRoot, board, mission, opts };
}

describe("runMissionDone", () => {
  it("refuses a mission with no gate records", async () => {
    const { opts, mission } = setup();
    const res = await runMissionDone(opts, mission.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("refusing to mark");
  });

  it("with force marks the mission done on disk", async () => {
    const { opts, mission, board } = setup();
    const res = await runMissionDone(opts, mission.id, "test force");
    expect(res).toEqual({ ok: true });
    expect(board.getMission(mission.id)?.status).toBe("done");
  });
});

describe("missionGuardApplies", () => {
  function primer(ws: string, v: number) {
    mkdirSync(join(ws, ".octobots", "hooks"), { recursive: true });
    writeFileSync(join(ws, ".octobots", "hooks", "primer.mjs"), `// octobots-pack-version: ${v}\n`);
  }
  it("is true for 65, false for 64 and for a missing primer", () => {
    const a = mkdtempClean("guard-a-"); primer(a, 65);
    const b = mkdtempClean("guard-b-"); primer(b, 64);
    expect(missionGuardApplies(a)).toBe(true);
    expect(missionGuardApplies(b)).toBe(false);
    expect(missionGuardApplies(mkdtempClean("guard-c-"))).toBe(false);
  });
});
