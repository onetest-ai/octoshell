// Synthetic boards for the tests-pairing rule: a campaign whose missions carry n acceptance
// criteria, an optional documents link, and a `tests/m<n>/` folder written file by file. Fixture
// specific assertions (a planted gap, an exact message) go on these; real boards are only ever compared
// validate.js against validateBoard, as sets (see fixtures/real-board.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { onTestFinished } from "vitest";
import { join } from "node:path";
import { createCampaign, createMission } from "../../src/write.js";
import { loadEntity, dumpEntity } from "../../src/entity-schema.js";

export interface SynthMission {
  /** "M1 - Auth": the id token decides the tests folder (m1). */
  title: string;
  /** Number of acceptance criteria (text "criterion k"). */
  acs: number;
  status?: string;
  /** Link the mission's tests README (the exact target add-tests.js writes). Default true. */
  linked?: boolean;
}

export interface SynthCampaign {
  /** The board directory (the folder holding campaigns/). */
  board: string;
  campaignDir: string;
  campaign: string;
  missionDirs: Record<string, string>;
  testsDir(folder: string): string;
}

/** A board with one campaign and the given missions, under `board` (an existing directory). */
export function synthBoard(board: string, missions: SynthMission[], campaignName = "Camp"): SynthCampaign {
  const c = createCampaign(board, { name: campaignName });
  const campaignDir = join(board, c.folderPath);
  const campaign = c.folderPath.split("/").pop()!;
  const missionDirs: Record<string, string> = {};
  for (const m of missions) {
    const made = createMission(board, c.id, { title: m.title });
    const dir = join(board, made.folderPath);
    const file = join(dir, "mission.yaml");
    const fields = loadEntity(readFileSync(file, "utf8"));
    const folder = m.title.split(" ")[0]!.toLowerCase();
    fields.acceptanceCriteria = Array.from({ length: m.acs }, (_, i) => ({ text: `criterion ${i + 1}`, done: false }));
    if (m.status) fields.status = m.status;
    fields.documents = m.linked === false ? [] : [{ label: `${m.title.split(" ")[0]} functional test cases`, target: `.octobots/campaigns/${campaign}/tests/${folder}/README.md` }];
    writeFileSync(file, dumpEntity("mission", fields), "utf8");
    missionDirs[folder] = dir;
  }
  return { board, campaignDir, campaign, missionDirs, testsDir: (folder) => join(campaignDir, "tests", folder) };
}

/** A well-formed TC file's text; `fm` lines are the frontmatter, `body` defaults to the two required sections. */
export function tcText(fm: string[], body = "# TC\n\n## Steps\n\n1. do\n\n## Expected Final State\n\nok\n"): string {
  return `---\n${fm.join("\n")}\n---\n\n${body}`;
}

export function writeTests(c: SynthCampaign, folder: string, files: Record<string, string>): void {
  const dir = c.testsDir(folder);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text, "utf8");
  }
}

/** A README whose AC map holds `rows` ([ac, "TC-001, TC-002"]). */
export function readmeText(rows: Array<[string, string]>): string {
  return [
    "# Suite",
    "",
    "## AC to test case map",
    "",
    "| AC | Summary | Test cases |",
    "|----|---------|------------|",
    ...rows.map(([ac, tcs]) => `| ${ac} | something | ${tcs} |`),
    "",
    "## Shared preconditions",
    "",
    "- x",
    "",
  ].join("\n");
}

/** A scratch board directory (named `.octobots`) that removes itself when the test finishes. */
export function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const board = join(root, ".octobots");
  mkdirSync(board);
  return board;
}
