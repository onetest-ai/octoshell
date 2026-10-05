import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardModel } from "@octoshell/board";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { realBoardCopies } from "./fixtures/real-board.js";

const SCRIPT = fileURLToPath(new URL("../scripts/qa/dump-ids.mjs", import.meta.url));
const BOARD_DIST = fileURLToPath(new URL("../../../packages/board/dist/index.js", import.meta.url));

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

/** Independent count: every entity BoardModel exposes, via the public read API. */
function entityCount(dir: string): number {
  const b = new BoardModel(dir);
  b.rebuild();
  let n = 0;
  for (const c of b.listCampaigns()) {
    n += 1 + b.listBugs({ campaignId: c.id }).length;
    for (const m of b.listMissions(c.id)) n += 1 + b.listTasks(m.id).length + b.listBugs({ missionId: m.id }).length;
  }
  return n;
}

describe("scripts/qa/dump-ids.mjs", () => {
  it("prints one sorted `<kind>\\t<id>` line per BoardModel entity over a copy of the real board", () => {
    for (const board of realBoardCopies()) {
      const r = run([board]);
      expect(r.status).toBe(0);
      const lines = r.stdout.split("\n").filter(Boolean);
      expect(lines.length).toBe(entityCount(board));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines).toEqual([...lines].sort());
      for (const l of lines) expect(l).toMatch(/^(campaign|mission|task|bug)\t\S+/);
      expect(new Set(lines).size).toBe(lines.length);
      expect(lines.some((l) => l.startsWith("campaign\t"))).toBe(true);
      expect(lines.some((l) => l.startsWith("task\t"))).toBe(true);
    }
  });

  it("--board-dist reads the board through the given library build (same output as the default here)", () => {
    const [board] = realBoardCopies();
    const viaDefault = run([board!]);
    const viaFlag = run([board!, "--board-dist", BOARD_DIST]);
    expect(viaFlag.status).toBe(0);
    expect(viaFlag.stdout).toBe(viaDefault.stdout);
    expect(run(["--board-dist=" + BOARD_DIST, board!]).stdout).toBe(viaDefault.stdout);
  });

  it("prints nothing for an empty board, and exits 2 with usage on bad arguments", () => {
    const empty = mkdtempClean("qa-ids-empty-");
    expect(run([empty])).toMatchObject({ status: 0, stdout: "" });
    expect(run([]).status).toBe(2);
    expect(run([empty, "--board-dist"]).status).toBe(2);
    expect(run([empty, "--nope"]).status).toBe(2);
    expect(run([join(empty, "missing")]).status).toBe(2);
    expect(run([empty, "--board-dist", join(empty, "no-such-dist.js")]).stderr).toContain("board dist not found");
  });
});
