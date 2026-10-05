// validateBoard reports each leftover `workflows/<slug>/` folder as a WARNING (workflow support was
// removed in pack v57), with the exact text the pack's validate.js prints. The rule is spelled once
// per runtime: legacy-workflows.mjs in the pack, and validate.ts here. This test pins the two to
// each other over a board built from TRACKED files only (what a CI checkout has; the working-tree
// `.octobots/` is gitignored and differs per machine).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { validateBoard } from "../src/validate.js";
import { campaignDirs, scratchDir, trackedBoardCopies } from "./fixtures/real-board.js";

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
  return workflowWarnings(root).map((f) => `warning: ${f.message}`);
}

/** validateBoard's workflows/ warnings (the tests-pairing ones are checked by validate-tests-parity.test.ts). */
const workflowWarnings = (root: string) => validateBoard(root).filter((f) => f.severity === "warning" && f.message.endsWith(SUFFIX));

/** A campaign dir the board model (and validate.js) treats as one: it holds a campaign.yaml/.md. */
const isEntityCampaign = (dir: string): boolean => existsSync(join(dir, "campaign.yaml")) || existsSync(join(dir, "campaign.md"));

/** Board-relative, `/`-separated path of `dir`, as validateBoard and validate.js report it. */
const rel = (board: string, dir: string): string => relative(board, dir).split(sep).join("/");

/** True when `dir` is a directory holding no sub-directory (an empty `workflows/` reports as itself). */
const hasNoSubdir = (dir: string): boolean =>
  existsSync(dir) && !readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory());

/**
 * Plant leftover workflows/ folders on the board's real campaigns: `workflows/w1` on each campaign
 * and `workflows/w2` on its first mission. `planted` is the board-relative (posix) path of each folder
 * it actually created; a folder the board already had is not counted. `superseded` is each existing
 * `workflows/` that held no sub-folder before planting: it was reported as itself, and once it holds
 * the planted folder it is reported through that folder instead.
 */
function plantWorkflows(board: string): { planted: string[]; superseded: string[] } {
  const planted: string[] = [];
  const superseded: string[] = [];
  const plant = (dir: string): void => {
    if (existsSync(dir)) return;
    const parent = join(dir, "..");
    if (hasNoSubdir(parent)) superseded.push(rel(board, parent));
    mkdirSync(dir, { recursive: true });
    planted.push(rel(board, dir));
  };
  for (const campaign of campaignDirs(board).filter(isEntityCampaign)) {
    plant(join(campaign, "workflows", "w1"));
    const missions = join(campaign, "missions");
    const first = existsSync(missions) ? readdirSync(missions)[0] : undefined;
    if (first) plant(join(missions, first, "workflows", "w2"));
  }
  return { planted, superseded };
}

/**
 * Plant on `board` and check validateBoard against what it reported before: exactly the baseline
 * warnings, less the superseded empty `workflows/` ones, plus one per planted folder (as a set and as
 * a count), no workflow error, and the same lines as validate.js.
 */
function expectBaselinePlusPlanted(board: string): void {
  // A real board copy (OCTOBOTS_BOARD_COPIES) may already hold leftover workflows/ folders, each a
  // correct warning. Take the baseline first, then expect exactly baseline + planted.
  const baseline = workflowWarnings(board).map((f) => f.message);
  const { planted, superseded } = plantWorkflows(board);
  expect(planted.length).toBeGreaterThan(0);
  const gone = new Set(superseded.map((p) => `${p}: ${SUFFIX}`));
  const expected = [...baseline.filter((m) => !gone.has(m)), ...planted.map((p) => `${p}: ${SUFFIX}`)].sort();
  const findings = validateBoard(board);
  const warnings = workflowWarnings(board);
  const messages = warnings.map((w) => w.message).sort();
  expect(messages).toEqual(expected); // exact: none from a dir that is no campaign, nothing pre-existing dropped
  expect(warnings.length).toBe(baseline.length - superseded.length + planted.length);
  for (const w of warnings) {
    expect(w.message).toMatch(new RegExp(`^campaigns/.+/workflows(/.+)?: ${SUFFIX}$`));
    expect(["campaign", "mission"]).toContain(w.kind);
  }
  expect(findings.filter((f) => f.severity === "error" && /workflow/i.test(f.message))).toEqual([]);

  const fromPack = campaignDirs(board).flatMap(packWarnings).sort();
  expect(boardWarnings(board).sort()).toEqual(fromPack);
}

describe("validateBoard: leftover workflows/ folders", () => {
  it("over every real board copy: one warning per workflows/ folder, no error for them, union equals validate.js", () => {
    for (const board of trackedBoardCopies()) expectBaselinePlusPlanted(board);
  });

  // Regression (M3 gate): a real board may hold an EMPTY workflows/ (octobots-doctor removes a
  // workflows/<slug> with the user's OK and can leave its parent behind). It reports as itself; once
  // the test plants w1 inside it, that finding is replaced, so "baseline + planted" over-counted by one.
  it("counts exactly when a campaign and its first mission already hold an empty workflows/", () => {
    const [board] = trackedBoardCopies();
    const campaign = campaignDirs(board!).filter(isEntityCampaign)[0]!;
    mkdirSync(join(campaign, "workflows"), { recursive: true });
    const missions = join(campaign, "missions");
    const first = existsSync(missions) ? readdirSync(missions)[0] : undefined;
    expect(first).toBeDefined();
    mkdirSync(join(missions, first!, "workflows"), { recursive: true });
    expect(workflowWarnings(board!).map((f) => f.message)).toEqual(
      expect.arrayContaining([`${rel(board!, join(campaign, "workflows"))}: ${SUFFIX}`]),
    );
    expectBaselinePlusPlanted(board!);
  });

  it("agrees with validate.js on a copy not named .octobots, and counts an empty workflows/ as one", () => {
    const [board] = trackedBoardCopies();
    const copy = join(scratchDir("board-copy-"), "my-board"); // no .octobots anywhere in the path
    cpSync(board!, copy, { recursive: true });
    const campaign = campaignDirs(copy).filter(isEntityCampaign)[0]!;
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
    const [board] = trackedBoardCopies(); // named .octobots
    const odd = join(board!, "campaigns", "campaigns");
    cpSync(campaignDirs(board!).filter(isEntityCampaign)[0]!, odd, { recursive: true });
    mkdirSync(join(odd, "workflows", "w"), { recursive: true });
    const lines = boardWarnings(board!);
    expect(lines).toContain(`warning: campaigns/campaigns/workflows/w: ${SUFFIX}`);
    expect(lines.sort()).toEqual(campaignDirs(board!).flatMap(packWarnings).sort());
  });

  // Regression (CI run 37332332841): a dir under campaigns/ with no campaign.yaml/.md is no campaign
  // to the board model, and validate.js refuses it ("no entity"). validateBoard must not warn for it.
  it("emits nothing for a campaigns/ dir with no campaign.yaml, as validate.js does", () => {
    const root = scratchDir("board-nonentity-");
    const dir = join(root, "campaigns", "stray");
    mkdirSync(join(dir, "missions", "m1", "workflows", "x"), { recursive: true });
    mkdirSync(join(dir, "workflows", "y"), { recursive: true });
    expect(workflowWarnings(root)).toEqual([]);
    const r = spawnSync("node", [VALIDATE_JS, dir], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/no entity/);
    expect(packWarnings(dir)).toEqual([]);
  });

  it("emits nothing for a board with no workflows/ folder", () => {
    const root = scratchDir("board-clean-");
    mkdirSync(join(root, "campaigns", "c1"), { recursive: true });
    expect(workflowWarnings(root)).toEqual([]);
  });

  it("keeps working when the board sits in <workspace>/.octobots", () => {
    const [board] = trackedBoardCopies();
    expect(plantWorkflows(board!).planted.length).toBeGreaterThan(0);
    const ws = scratchDir("ws-");
    cpSync(board!, join(ws, ".octobots"), { recursive: true });
    const viaWorkspace = boardWarnings(ws).sort();
    expect(viaWorkspace.length).toBeGreaterThan(0);
    expect(viaWorkspace).toEqual(boardWarnings(join(ws, ".octobots")).sort());
  });
});
