// validateBoard reports each leftover `workflows/<slug>/` folder as a WARNING (workflow support was
// removed in pack v57), with the exact text the pack's validate.js prints. The rule is spelled once
// per runtime: legacy-workflows.mjs in the pack, and validate.ts here. This test pins the two to
// each other over a real board copy.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateBoard } from "../src/validate.js";
import { campaignDirs, realBoardCopies, scratchDir } from "./fixtures/real-board.js";

const SCRIPTS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts");
const VALIDATE_JS = join(SCRIPTS, "validate.js");
const SUFFIX = "no longer read since pack v57";

/** The `warning:` lines validate.js prints for one campaign dir, whatever its exit status. */
function packWarnings(campaignDir: string): string[] {
  const r = spawnSync("node", [VALIDATE_JS, campaignDir], { encoding: "utf8" });
  return r.stdout.split("\n").filter((l) => l.startsWith("warning: ") && l.endsWith(SUFFIX));
}

/** validateBoard's warnings as the `warning: <message>` lines validate.js prints. */
function boardWarnings(root: string): string[] {
  return validateBoard(root).filter((f) => f.severity === "warning").map((f) => `warning: ${f.message}`);
}

describe("validateBoard: leftover workflows/ folders", () => {
  it("over every real board copy: one warning per workflows/ folder, no error for them, union equals validate.js", () => {
    for (const board of realBoardCopies()) {
      const findings = validateBoard(board);
      const warnings = findings.filter((f) => f.severity === "warning");
      expect(warnings.length).toBeGreaterThan(0); // the copy really has workflows/ folders
      for (const w of warnings) {
        expect(w.message).toMatch(new RegExp(`^campaigns/.+/workflows/.+: ${SUFFIX}$`));
        expect(["campaign", "mission"]).toContain(w.kind);
      }
      expect(findings.filter((f) => f.severity === "error" && /workflow/i.test(f.message))).toEqual([]);

      const fromPack = campaignDirs(board).flatMap(packWarnings).sort();
      expect(boardWarnings(board).sort()).toEqual(fromPack);
    }
  });

  it("agrees with validate.js on a copy not named .octobots, and counts an empty workflows/ as one", () => {
    const [board] = realBoardCopies();
    const copy = join(scratchDir("board-copy-"), "my-board"); // no .octobots anywhere in the path
    cpSync(board!, copy, { recursive: true });
    const campaign = campaignDirs(copy)[0]!;
    mkdirSync(join(campaign, "workflows"), { recursive: true }); // no sub-folder: counts as itself
    // a stray file in workflows/ is not a folder, so it adds no finding of its own
    writeFileSync(join(campaign, "workflows", "README"), "x");
    const lines = boardWarnings(copy);
    expect(lines.some((l) => /^warning: campaigns\/[^/]+\/workflows: /.test(l))).toBe(true);
    expect(lines.every((l) => l.startsWith("warning: campaigns/"))).toBe(true);
    expect(lines.sort()).toEqual(campaignDirs(copy).flatMap(packWarnings).sort());
  });

  // Pins the FIRST branch of boardRootOf (nearest `.octobots` wins) on both runtimes. On every
  // ordinary layout the second branch (parent of the nearest `campaigns`) gives the same answer, so
  // without a folder literally named `campaigns` inside the board either side could drop the
  // `.octobots` branch and stay green while the two disagree.
  it("reports from the .octobots root even when a campaign folder is itself named campaigns", () => {
    const [board] = realBoardCopies(); // named .octobots
    const odd = join(board!, "campaigns", "campaigns");
    cpSync(campaignDirs(board!)[0]!, odd, { recursive: true });
    mkdirSync(join(odd, "workflows", "w"), { recursive: true });
    const lines = boardWarnings(board!);
    expect(lines).toContain(`warning: campaigns/campaigns/workflows/w: ${SUFFIX}`);
    expect(lines.sort()).toEqual(campaignDirs(board!).flatMap(packWarnings).sort());
  });

  it("emits nothing for a board with no workflows/ folder", () => {
    const root = scratchDir("board-clean-");
    mkdirSync(join(root, "campaigns", "c1"), { recursive: true });
    expect(validateBoard(root).filter((f) => f.severity === "warning")).toEqual([]);
  });

  it("keeps working when the board sits in <workspace>/.octobots", () => {
    const [board] = realBoardCopies();
    const ws = scratchDir("ws-");
    cpSync(board!, join(ws, ".octobots"), { recursive: true });
    const viaWorkspace = boardWarnings(ws).sort();
    expect(viaWorkspace.length).toBeGreaterThan(0);
    expect(viaWorkspace).toEqual(boardWarnings(join(ws, ".octobots")).sort());
  });
});
