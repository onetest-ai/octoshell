import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardModel } from "../src/board-model.js";
import { validateBoard } from "../src/validate.js";
import {
  createWorkflow, deleteWorkflow, appendWorkflowRun, migrateLegacyWorkflows,
} from "../src/write.js";

function fixture(): { root: string; campaignId: string; missionId: string } {
  const root = mkdtempSync(join(tmpdir(), "wf-write-"));
  const c = join(root, "campaigns", "alpha");
  mkdirSync(join(c, "missions", "m1-auth"), { recursive: true });
  writeFileSync(join(c, "campaign.md"), "# Alpha\n\n## Description\nx\n");
  writeFileSync(join(c, "missions", "m1-auth", "mission.md"), "# M1 - Auth\n\n## Description\nx\n");
  const board = new BoardModel(root);
  board.rebuild();
  const campaignId = board.listCampaigns()[0]!.id;
  return { root, campaignId, missionId: board.listMissions(campaignId)[0]!.id };
}

function read(root: string, id: string, file: string): string {
  const board = new BoardModel(root);
  board.rebuild();
  return readFileSync(join(root, board.getWorkflow(id)!.folderPath, file), "utf8");
}

describe("createWorkflow", () => {
  it("scaffolds a parseable workflow under a campaign", () => {
    const { root, campaignId } = fixture();
    const { folderPath } = createWorkflow(root, { campaignId }, { name: "Ship Missions" });
    expect(folderPath).toBe("campaigns/alpha/workflows/ship-missions");
    expect(existsSync(join(root, folderPath, "workflow.md"))).toBe(false); // js-only — no markdown
    expect(existsSync(join(root, folderPath, "workflow.js"))).toBe(true);

    const board = new BoardModel(root);
    board.rebuild();
    const [wf] = board.listWorkflows({ campaignId });
    expect(wf!.parseError).toBeNull();
    expect(wf!.name).toBe("ship-missions");
    expect(wf!.phases).toHaveLength(1);
  });

  // The scaffold is advice as much as code: it is the first thing an author reads in a new
  // workflow. It carried the retired "keep `meta.phases` in step with the phases this body enters"
  // doctrine for a whole branch after `meta` became generated, because nothing validated a
  // freshly-scaffolded workflow or read its comment. Both are checked here.
  it("scaffolds a workflow that validates clean and points the author at sync-meta.js", () => {
    const { root, campaignId } = fixture();
    // validateBoard walks `<root>/.octobots`, while this fixture's root IS the board dir — so
    // validate from the parent, the same relationship a real workspace has.
    const { folderPath } = createWorkflow(root, { campaignId }, { name: "Ship Missions" });
    const project = mkdtempSync(join(tmpdir(), "wf-val-root-"));
    cpSync(root, join(project, ".octobots"), { recursive: true });

    expect(validateBoard(project).filter((f) => f.kind === "workflow")).toEqual([]);

    const script = readFileSync(join(root, folderPath, "workflow.js"), "utf8");
    expect(script).toContain("sync-meta.js");
    expect(script).toContain("GENERATED from this code");
    // The retired doctrine: meta is no longer a thing the author keeps in step by hand.
    expect(script).not.toContain("Keep `meta.phases`");
    expect(script).not.toContain("draws its diagram from meta, not from this code");
  });

  it("scaffolds under a mission and de-duplicates slugs", () => {
    const { root, missionId } = fixture();
    const a = createWorkflow(root, { missionId }, { name: "Build" });
    const b = createWorkflow(root, { missionId }, { name: "Build" });
    expect(a.folderPath).not.toBe(b.folderPath);
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.listWorkflows({ missionId })).toHaveLength(2);
  });
});

describe("appendWorkflowRun", () => {
  it("appends JSON lines to runs.jsonl and drives lastRunStatus", () => {
    const { root, campaignId } = fixture();
    const { id, folderPath } = createWorkflow(root, { campaignId }, { name: "w" });
    expect(appendWorkflowRun(root, id, { status: "done", summary: "4 agents, 12m", at: "2026-07-23" })).toBe(true);
    expect(appendWorkflowRun(root, id, { status: "failed", summary: "review phase", at: "2026-07-24" })).toBe(true);

    // Runs live in runs.jsonl, one JSON object per line — no workflow.md.
    expect(existsSync(join(root, folderPath, "workflow.md"))).toBe(false);
    const lines = read(root, id, "runs.jsonl").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ status: "done", summary: "4 agents, 12m", at: "2026-07-23" });
    expect(JSON.parse(lines[1]!).status).toBe("failed");

    const board = new BoardModel(root);
    board.rebuild();
    expect(board.getWorkflow(id)!.lastRunStatus).toBe("failed"); // newest line wins
  });
});

describe("migrateLegacyWorkflows", () => {
  const LEGACY_MD =
    "# w\n\n## Description\nd\n\n## Runs\n- [status:done] 2026-07-23 — first\n- [status:failed] 2026-07-24 — second\n\n" +
    "<!-- Auto-generated by Octobots ... -->\n## Notes\n_(none)_\n";
  const LEGACY_JS =
    "export const meta = { name: 'w', description: 'd', phases: [{ title: 'Run', steps: [{ id: 's1', agent: 'claude', label: 'go' }] }] }\n";

  function legacyWorkflow(root: string): string {
    const dir = join(root, "campaigns", "alpha", "workflows", "w");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "campaigns", "alpha", "campaign.md"), "# Alpha\n\n## Description\nx\n");
    writeFileSync(join(dir, "workflow.md"), LEGACY_MD);
    writeFileSync(join(dir, "workflow.js"), LEGACY_JS);
    return dir;
  }

  it("converts ## Runs to runs.jsonl, deletes workflow.md, and preserves lastRunStatus", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-migrate-"));
    const dir = legacyWorkflow(root);

    expect(migrateLegacyWorkflows(root)).toBe(1);
    expect(existsSync(join(dir, "workflow.md"))).toBe(false);
    const lines = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ status: "done", summary: "first", at: "2026-07-23" });

    const board = new BoardModel(root);
    board.rebuild();
    const [wf] = board.listWorkflows({ campaignId: board.listCampaigns()[0]!.id });
    expect(wf!.lastRunStatus).toBe("failed"); // newest line
    expect(wf!.parseError).toBeNull();
  });

  it("is idempotent and leaves an already-migrated folder untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-migrate-"));
    legacyWorkflow(root);
    migrateLegacyWorkflows(root);
    expect(migrateLegacyWorkflows(root)).toBe(0); // nothing left to retire
  });

  it("does not overwrite an existing runs.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-migrate-"));
    const dir = legacyWorkflow(root);
    writeFileSync(join(dir, "runs.jsonl"), '{"status":"cancelled","summary":"pre","at":"2026-06-01"}\n');
    migrateLegacyWorkflows(root);
    expect(readFileSync(join(dir, "runs.jsonl"), "utf8")).toContain("cancelled");
    expect(existsSync(join(dir, "workflow.md"))).toBe(false); // still retires the .md
  });
});

describe("deleteWorkflow", () => {
  it("removes the folder", () => {
    const { root, campaignId } = fixture();
    const { id, folderPath } = createWorkflow(root, { campaignId }, { name: "w" });
    expect(deleteWorkflow(root, id)).toBe(true);
    expect(existsSync(join(root, folderPath, "workflow.js"))).toBe(false);
    const board = new BoardModel(root);
    board.rebuild();
    expect(board.listWorkflows({ campaignId })).toHaveLength(0);
  });
});
