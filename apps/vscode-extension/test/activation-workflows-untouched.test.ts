import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BoardHost, openBoard } from "../src/host/board-host.js";
import { realBoardCopies, workflowFileHashes } from "./fixtures/real-board.js";

describe("activating the board leaves every workflows/ file alone", () => {
  it("sha256 of every file under any workflows/ is equal before and after", () => {
    for (const dir of realBoardCopies()) {
      const before = workflowFileHashes(dir);
      const board = openBoard(dir);
      const after = workflowFileHashes(dir);
      expect(board.listCampaigns().length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    }
  });

  it("a legacy workflow.md next to a workflow.js is no longer retired or rewritten", () => {
    const [dir] = realBoardCopies();
    const campaign = board0(dir!);
    const wf = join(dir!, campaign, "workflows", "legacy");
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "workflow.md"), "# Legacy\n\n## Description\nold\n");
    writeFileSync(join(wf, "workflow.js"), "export const meta = { name: 'legacy', phases: [] };\n");
    const before = workflowFileHashes(dir!);
    openBoard(dir!);
    expect(existsSync(join(wf, "workflow.md"))).toBe(true);
    expect(workflowFileHashes(dir!)).toEqual(before);
  });

  it("the board under test really has workflows/ files to protect", () => {
    const total = realBoardCopies().reduce((n, dir) => n + Object.keys(workflowFileHashes(dir)).length, 0);
    expect(total).toBeGreaterThan(0);
  });
});

/** Folder (relative to the .octobots dir) of the first campaign on the board. */
function board0(dir: string): string {
  return new BoardHost(dir).listCampaigns()[0]!.folderPath;
}
