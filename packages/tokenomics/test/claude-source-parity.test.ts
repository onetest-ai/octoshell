import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeTranscriptSource, projectSlug } from "../src/claude-source.js";

// Mission AC4: the pack CLI (collect.mjs) and the extension's TS source must return the SAME segment
// ids for the same roots. Both run here against one temp tree, in a child process with an isolated env.
const COLLECT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/vscode-extension/resources/octobots-pack/tokenomics/collect.mjs",
);

const tmp = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const slugOf = (p: string): string => p.replace(/[^A-Za-z0-9]/g, "-");

const turn = (branch: string, requestId: string): string =>
  JSON.stringify({
    type: "assistant",
    gitBranch: branch,
    requestId,
    timestamp: "2026-07-01T10:00:00.000Z",
    message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 10 }, content: [] },
  });

function session(projectsRoot: string, slug: string, id: string, turns: number, subagents: string[] = []): void {
  const dir = join(projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: turns }, (_, i) => turn("feat/p", `${id}-r${i}`));
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  for (const rel of subagents) {
    const sub = join(dir, id, "subagents", dirname(rel));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, id, "subagents", rel), turn("feat/p", `${id}-${rel}`) + "\n");
  }
}

interface World {
  base: string;
  /** Project path contains `_` and `.` on purpose: both collapse to "-". */
  project: string;
  slug: string;
  home: string;
  cfg: string;
  explicit: string;
}

function world(): World {
  const base = tmp("tok-parity-");
  const project = join(base, "my_proj.v2");
  mkdirSync(project, { recursive: true });
  const slug = slugOf(project);
  const home = join(base, "home");
  const cfg = join(base, "cfg");
  const explicit = join(base, "explicit");
  const homeRoot = join(home, ".claude", "projects");
  const legacy = join(project, ".claude", "projects");
  // home: a main session with a flat subagent and a nested Workflow agent, plus another project's slug.
  session(homeRoot, slug, "home-s", 2, ["agent-flat.jsonl", "workflows/wf_abc/agent-nested.jsonl"]);
  session(homeRoot, slugOf(join(base, "other")), "other-s", 3);
  // legacy: a different session, other slugs, and a duplicate of home-s with MORE turns.
  session(legacy, slug, "legacy-s", 1);
  session(legacy, "-Users-someone-else", "legacy-other", 4);
  session(legacy, slug, "home-s", 5);
  // cfg + explicit roots.
  session(join(cfg, "projects"), slug, "cfg-s", 2);
  session(explicit, slug, "explicit-s", 2);
  return { base, project, slug, home, cfg, explicit };
}

/** Run the pack CLI against `projectDir` with an isolated env; returns its segment records. */
function cli(projectDir: string, env: Record<string, string>, extra: string[] = [], cwd?: string) {
  execFileSync(process.execPath, [COLLECT, "--project-dir", projectDir, "--quiet", ...extra], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { PATH: process.env.PATH ?? "", ...env },
    ...(cwd ? { cwd } : {}),
  });
  const abs = cwd ? join(cwd, projectDir) : projectDir;
  const raw = readFileSync(join(abs, ".octobots", "tokenomics", "raw", "segments.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { segment_id: string; turns: number });
}

const view = (segs: { segmentId?: string; segment_id?: string; turns: number }[]): string[] =>
  segs.map((s) => `${s.segmentId ?? s.segment_id}=${s.turns}`).sort();

describe("ClaudeTranscriptSource / collect.mjs parity (mission AC4)", () => {
  it("home default: same segment ids, own slug only, richer duplicate wins", () => {
    const w = world();
    const theirs = cli(w.project, { HOME: w.home });
    const ours = new ClaudeTranscriptSource(w.project, { homeDir: w.home, env: {} }).collect();
    expect(view(ours)).toEqual(view(theirs));
    expect(view(ours)).toContain("home-s:main:feat/p=5");
    expect(ours.some((s) => s.sessionId === "other-s" || s.sessionId === "legacy-other")).toBe(false);
    expect(ours.some((s) => s.workflowId === "wf_abc")).toBe(true);
  });

  it("CLAUDE_CONFIG_DIR replaces the home default", () => {
    const w = world();
    const theirs = cli(w.project, { HOME: w.home, CLAUDE_CONFIG_DIR: w.cfg });
    const ours = new ClaudeTranscriptSource(w.project, { homeDir: w.home, env: { CLAUDE_CONFIG_DIR: w.cfg } }).collect();
    expect(view(ours)).toEqual(view(theirs));
    expect(view(ours).some((v) => v.startsWith("cfg-s:"))).toBe(true);
  });

  it("OCTOBOTS_TOKENOMICS_PROJECTS_DIR and --projects-dir replace both", () => {
    const w = world();
    const env = { HOME: w.home, CLAUDE_CONFIG_DIR: w.cfg };
    const viaEnv = cli(w.project, { ...env, OCTOBOTS_TOKENOMICS_PROJECTS_DIR: w.explicit });
    const oursEnv = new ClaudeTranscriptSource(w.project, {
      homeDir: w.home,
      env: { ...env, OCTOBOTS_TOKENOMICS_PROJECTS_DIR: w.explicit },
    }).collect();
    expect(view(oursEnv)).toEqual(view(viaEnv));
    const viaFlag = cli(w.project, env, ["--projects-dir", w.explicit]);
    const oursFlag = new ClaudeTranscriptSource(w.project, { homeDir: w.home, env, projectsDir: w.explicit }).collect();
    expect(view(oursFlag)).toEqual(view(viaFlag));
    expect(view(oursFlag).some((v) => v.startsWith("explicit-s:"))).toBe(true);
    expect(view(oursFlag).some((v) => v.startsWith("home-s:"))).toBe(true); // legacy still read
  });

  it("a /.claude/worktrees/ path resolves to the main checkout's slug", () => {
    const w = world();
    const wt = join(w.project, ".claude", "worktrees", "qa-wt");
    mkdirSync(wt, { recursive: true });
    const theirs = cli(wt, { HOME: w.home });
    const src = new ClaudeTranscriptSource(wt, { homeDir: w.home, env: {} });
    expect(src.slug).toBe(w.slug);
    expect(view(src.collect())).toEqual(view(theirs));
    expect(theirs.length).toBeGreaterThan(0);
  });

  // The tie rule is invisible to `view` (ids and turns are equal by definition), so this case gives the two
  // equal-turn copies different token counts and compares those: a ">=" on either side flips the winner.
  it("a duplicate with EQUAL turns keeps the earlier root's copy, on both sides", () => {
    const w = world();
    const write = (projectsRoot: string, output: number): void => {
      const dir = join(projectsRoot, w.slug);
      mkdirSync(dir, { recursive: true });
      const line = (i: number): string =>
        JSON.stringify({
          type: "assistant",
          gitBranch: "feat/p",
          requestId: `tie-r${i}`,
          timestamp: "2026-07-01T10:00:00.000Z",
          message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: output }, content: [] },
        });
      writeFileSync(join(dir, "tie-s.jsonl"), [line(0), line(1)].join("\n") + "\n");
    };
    write(join(w.home, ".claude", "projects"), 111); // earlier root
    write(join(w.project, ".claude", "projects"), 999); // legacy root, read later
    const theirs = cli(w.project, { HOME: w.home }) as unknown as {
      segment_id: string;
      tokens_by_model: Record<string, { output_tokens: number }>;
    }[];
    const ours = new ClaudeTranscriptSource(w.project, { homeDir: w.home, env: {} }).collect();
    const cliTie = theirs.find((s) => s.segment_id === "tie-s:main:feat/p");
    const tsTie = ours.find((s) => s.segmentId === "tie-s:main:feat/p");
    expect(cliTie?.tokens_by_model["claude-sonnet-5"]?.output_tokens).toBe(222);
    expect(tsTie?.tokensByModel["claude-sonnet-5"]?.output).toBe(222);
  });

  it("a trailing slash or a relative project path yields the same slug and the same ids", () => {
    const w = world();
    const theirsSlash = cli(`${w.project}/`, { HOME: w.home });
    const ours = new ClaudeTranscriptSource(`${w.project}/`, { homeDir: w.home, env: {} });
    expect(projectSlug(`${w.project}/`)).toBe(w.slug);
    expect(view(ours.collect())).toEqual(view(theirsSlash));
    expect(theirsSlash.length).toBeGreaterThan(0);

    const w2 = world();
    const rel = relative(w2.base, w2.project);
    const theirsRel = cli(rel, { HOME: w2.home }, [], w2.base);
    expect(view(new ClaudeTranscriptSource(w2.project, { homeDir: w2.home, env: {} }).collect())).toEqual(view(theirsRel));
    expect(theirsRel.length).toBeGreaterThan(0);
  });
});
