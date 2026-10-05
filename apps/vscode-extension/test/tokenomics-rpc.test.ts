import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderManagedBlock } from "@octoshell/board";
import { BoardHost } from "../src/host/board-host.js";
import { dispatch, type DispatchCtx } from "../src/host/rpc-dispatcher.js";
import type { Report } from "@octoshell/tokenomics";
import { mkdtempClean } from "./fixtures/tmpdir.js";

let root: string;
// `mkdtempClean` is called from inside `beforeEach`, which runs within the current test's
// context (vitest sets the active test before running its `beforeEach` chain), so the
// `onTestFinished` cleanup it registers still fires for the right test — see fixtures/tmpdir.ts.
beforeEach(() => { root = mkdtempClean("tok-rpc-"); });

function writeBrief(kind: "campaign" | "mission", dir: string, fields: Record<string, unknown>, tail = "") {
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeFileSync(join(dir, `${kind}.md`), renderManagedBlock(kind, fields as any, [], "planner") + tail, "utf8");
}

function transcript(branch: string, projectsRoot = join(root, ".claude", "projects"), slug = root.replace(/[^A-Za-z0-9]/g, "-"), session = "sess-1"): void {
  const proj = join(projectsRoot, slug);
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, `${session}.jsonl`),
    JSON.stringify({
      type: "assistant",
      gitBranch: branch,
      requestId: "r1",
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 5000 },
        content: [],
      },
    }) + "\n",
  );
}

function ctx(): DispatchCtx {
  const board = new BoardHost(join(root, ".octobots"));
  return {
    board,
    workspaceFolderPath: root,
    // Unused by this route; the dispatcher only touches board + workspace path.
  } as unknown as DispatchCtx;
}

describe("tokenomics:report", () => {
  it("returns a priced report attributed to the board's mission", async () => {
    const c = join(root, ".octobots", "campaigns", "demo");
    writeBrief("campaign", c, { name: "Demo", description: "", acceptanceCriteria: "", status: "draft", target: "" });
    writeBrief("mission", join(c, "missions", "m1"),
      { name: "M1 - Demo", description: "d", acceptanceCriteria: "- [ ] ac" },
      "\n## Tokenomics\neffort_days: 2\nsize_tshirt: M\n");
    transcript("feat/demo-m1");

    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.agentTool).toBe("claude-code");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]!.missionTitle).toBe("M1 - Demo");
    expect(report.runs[0]!.estimate).toMatchObject({ effortDays: 2, sizeTshirt: "M" });
    expect(report.runs[0]!.costUsd).toBeGreaterThan(0);
  });

  it("returns an empty report rather than throwing when nothing has been measured", async () => {
    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.runs).toEqual([]);
    expect(report.unattributed.segments).toBe(0);
  });

  it("reports off-board work as unattributed instead of dropping it", async () => {
    const c = join(root, ".octobots", "campaigns", "demo");
    writeBrief("campaign", c, { name: "Demo", description: "", acceptanceCriteria: "", status: "draft", target: "" });
    transcript("main");
    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.runs).toEqual([]);
    expect(report.unattributed.branches).toEqual(["main"]);
    expect(report.unattributed.costUsd).toBeGreaterThan(0);
  });
});

/**
 * Mission AC4, the data half of the webview: the Tokenomics view renders exactly what this route
 * returns, so the route must read the HOME root (Claude Code's default `~/.claude/projects/<slug>`),
 * not only the legacy repo-local one, and must take only the workspace's own slug from either.
 * HOME and the two override variables are pinned, so the developer's real transcripts never leak in.
 */
describe("tokenomics:report reads the home transcript root (AC4)", () => {
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, OCTOBOTS_TOKENOMICS_PROJECTS_DIR: process.env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("includes a session that exists only under ~/.claude/projects/<slug>, and no other project's slug", async () => {
    const home = mkdtempClean("tok-rpc-home-");
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR;

    const c = join(root, ".octobots", "campaigns", "demo");
    writeBrief("campaign", c, { name: "Demo", description: "", acceptanceCriteria: "", status: "draft", target: "" });
    writeBrief("mission", join(c, "missions", "m1"), { name: "M1 - Demo", description: "d", acceptanceCriteria: "- [ ] ac" });
    transcript("feat/demo-m1", join(home, ".claude", "projects"), undefined, "home-only");
    // Decoys: another project's slug dir in BOTH roots (the shape of octoshell's own legacy root).
    transcript("feat/demo-m1", join(home, ".claude", "projects"), "-Users-someone-else", "decoy-home");
    transcript("feat/demo-m1", join(root, ".claude", "projects"), "-private-tmp", "decoy-legacy");

    const report = (await dispatch("tokenomics:report", {}, ctx())) as Report;
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]!.missionTitle).toBe("M1 - Demo");
    expect(report.runs[0]!.sessions).toBe(1); // home-only, and neither decoy
    expect(report.runs[0]!.turns).toBe(1);
    expect(report.unattributed.segments).toBe(0);
  });
});
