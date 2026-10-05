import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeTranscriptSource, projectSlug, resolveTranscriptRoots } from "../src/claude-source.js";

function turn(opts: {
  branch: string;
  requestId?: string;
  model?: string;
  output?: number;
  cacheRead?: number;
  create5m?: number;
  create1h?: number;
  tool?: string;
}): string {
  const created = (opts.create5m ?? 0) + (opts.create1h ?? 0);
  return JSON.stringify({
    type: "assistant",
    gitBranch: opts.branch,
    requestId: opts.requestId,
    timestamp: "2026-07-01T10:00:00.000Z",
    message: {
      model: opts.model ?? "claude-sonnet-5",
      usage: {
        input_tokens: 10,
        output_tokens: opts.output ?? 100,
        cache_read_input_tokens: opts.cacheRead ?? 1000,
        cache_creation_input_tokens: created,
        ...(created
          ? {
              cache_creation: {
                ephemeral_5m_input_tokens: opts.create5m ?? 0,
                ephemeral_1h_input_tokens: opts.create1h ?? 0,
              },
            }
          : {}),
      },
      content: opts.tool ? [{ type: "tool_use", name: opts.tool }] : [],
    },
  });
}

const SESSION = "s0000000-0000-0000-0000-000000000001";

const tmp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A source with an empty injected HOME and env, so the developer's real ~/.claude never leaks in. */
function src(root: string, opts: { homeDir?: string; env?: Record<string, string> } = {}): ClaudeTranscriptSource {
  return new ClaudeTranscriptSource(root, { homeDir: opts.homeDir ?? tmp("tok-home-"), env: opts.env ?? {} });
}

/** Writes one top-level session (plus optional subagents) under `<projectsRoot>/<slug>`. */
function writeSession(
  projectsRoot: string,
  slug: string,
  sessionId: string,
  lines: string[],
  subagents: { path: string; agentType?: string; line: string }[] = [],
): void {
  const proj = join(projectsRoot, slug);
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  for (const s of subagents) {
    const dir = join(proj, sessionId, "subagents", s.path);
    mkdirSync(dir, { recursive: true });
    // Agent ids are unique per session; segments dedupe on id, so two files must not share one.
    const agent = `agent-${s.path.replace(/\W/g, "_")}`;
    writeFileSync(join(dir, `${agent}.jsonl`), s.line + "\n");
    if (s.agentType) {
      writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify({ agentType: s.agentType }));
    }
  }
}

/** A workspace whose transcripts sit in its legacy repo-local root, under its own slug. */
function repo(lines: string[], subagents: { path: string; agentType?: string; line: string }[] = []): string {
  const root = tmp("tok-src-");
  writeSession(join(root, ".claude", "projects"), projectSlug(root), SESSION, lines, subagents);
  return root;
}

const t = (id: string, branch = "feat/x") => turn({ branch, requestId: id });

describe("ClaudeTranscriptSource", () => {
  // Streaming re-emits the same usage payload; without dedupe every count doubles.
  it("counts a request once even when streaming repeats its usage payload", () => {
    const root = repo([
      turn({ branch: "feat/x", requestId: "req-1" }),
      turn({ branch: "feat/x", requestId: "req-1" }),
      turn({ branch: "feat/x", requestId: "req-2" }),
    ]);
    const [seg] = src(root).collect();
    expect(seg!.turns).toBe(2);
    expect(seg!.tokensByModel["claude-sonnet-5"]!.output).toBe(200);
  });

  it("splits one session into a segment per branch", () => {
    const root = repo([
      turn({ branch: "feat/a", requestId: "r1" }),
      turn({ branch: "feat/b", requestId: "r2" }),
    ]);
    expect(src(root).collect().map((s) => s.branch).sort()).toEqual([
      "feat/a",
      "feat/b",
    ]);
  });

  // Workflow agents nest under subagents/workflows/wf_*/. A flat read finds a
  // fraction of subagent work and reports the orchestrator as spending 100%.
  it("finds workflow agents nested under subagents/workflows/, not just flat ones", () => {
    const root = repo(
      [turn({ branch: "feat/x", requestId: "r1" })],
      [
        { path: ".", agentType: "python-dev", line: turn({ branch: "feat/x", requestId: "s1" }) },
        { path: "workflows/wf_abc", agentType: "js-dev", line: turn({ branch: "feat/x", requestId: "s2" }) },
      ],
    );
    const segs = src(root).collect();
    const subs = segs.filter((s) => s.kind === "subagent");
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.agentType).sort()).toEqual(["js-dev", "python-dev"]);
    expect(subs.find((s) => s.agentType === "js-dev")!.workflowId).toBe("wf_abc");
  });

  it("keeps the 5m/1h cache-write split, which bill at different rates", () => {
    const root = repo([turn({ branch: "feat/x", requestId: "r1", create5m: 300, create1h: 700 })]);
    const t = src(root).collect()[0]!.tokensByModel["claude-sonnet-5"]!;
    expect(t.cacheCreate5m).toBe(300);
    expect(t.cacheCreate1h).toBe(700);
    expect(t.cacheCreate).toBe(1000);
  });

  it("attributes an unsplit cache write to the cheaper 5m bucket", () => {
    const line = JSON.stringify({
      type: "assistant",
      gitBranch: "feat/x",
      requestId: "r1",
      message: { model: "claude-sonnet-5", usage: { cache_creation_input_tokens: 500 }, content: [] },
    });
    const t = src(repo([line])).collect()[0]!.tokensByModel["claude-sonnet-5"]!;
    expect(t.cacheCreate5m).toBe(500);
    expect(t.cacheCreate1h).toBe(0);
  });

  it("counts tool calls and survives a truncated tail line", () => {
    const root = repo([turn({ branch: "feat/x", requestId: "r1", tool: "Edit" }), '{"type":"assist']);
    const [seg] = src(root).collect();
    expect(seg!.tools["Edit"]).toBe(1);
  });

  it("returns nothing when the repo has no transcripts", () => {
    expect(src(tmp("tok-empty-")).collect()).toEqual([]);
  });
});

describe("ClaudeTranscriptSource roots (mission AC4)", () => {
  it("reads sessions that exist only under the home root", () => {
    const ws = tmp("tok-ws-");
    const home = tmp("tok-home-");
    writeSession(join(home, ".claude", "projects"), projectSlug(ws), "home-only", [t("r1"), t("r2")]);
    const segs = src(ws, { homeDir: home }).collect();
    expect(segs.map((s) => s.segmentId)).toEqual(["home-only:main:feat/x"]);
    expect(segs[0]!.turns).toBe(2);
  });

  it("a repo-local root holding other projects' slug dirs contributes only the repo's own slug", () => {
    const ws = tmp("tok-ws-");
    const legacy = join(ws, ".claude", "projects");
    writeSession(legacy, projectSlug(ws), "mine", [t("r1")]);
    writeSession(legacy, "-Users-someone-analysta", "other-a", [t("r2")]);
    writeSession(legacy, "-private-tmp", "other-b", [t("r3")]);
    const ids = src(ws).collect().map((s) => s.sessionId);
    expect(ids).toEqual(["mine"]);
  });

  it("merges the home root and the legacy root; CLAUDE_CONFIG_DIR/projects replaces ~/.claude/projects", () => {
    const ws = tmp("tok-ws-");
    const home = tmp("tok-home-");
    const cfg = tmp("tok-cfg-");
    const slug = projectSlug(ws);
    writeSession(join(home, ".claude", "projects"), slug, "home-s", [t("r1")]);
    writeSession(join(cfg, "projects"), slug, "cfg-s", [t("r2")]);
    writeSession(join(ws, ".claude", "projects"), slug, "legacy-s", [t("r3")]);
    const ids = (e: Record<string, string>) =>
      src(ws, { homeDir: home, env: e }).collect().map((s) => s.sessionId).sort();
    expect(ids({})).toEqual(["home-s", "legacy-s"]);
    expect(ids({ CLAUDE_CONFIG_DIR: cfg })).toEqual(["cfg-s", "legacy-s"]);
  });

  it("an explicit projects dir (option or env) replaces both home and config dir, legacy still read", () => {
    const ws = tmp("tok-ws-");
    const home = tmp("tok-home-");
    const cfg = tmp("tok-cfg-");
    const explicit = tmp("tok-explicit-");
    const slug = projectSlug(ws);
    writeSession(join(home, ".claude", "projects"), slug, "home-s", [t("r1")]);
    writeSession(join(cfg, "projects"), slug, "cfg-s", [t("r2")]);
    writeSession(explicit, slug, "explicit-s", [t("r3")]);
    const viaEnv = new ClaudeTranscriptSource(ws, {
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: cfg, OCTOBOTS_TOKENOMICS_PROJECTS_DIR: explicit },
    });
    expect(viaEnv.collect().map((s) => s.sessionId)).toEqual(["explicit-s"]);
    const viaOpt = new ClaudeTranscriptSource(ws, { homeDir: home, env: { CLAUDE_CONFIG_DIR: cfg }, projectsDir: explicit });
    expect(viaOpt.collect().map((s) => s.sessionId)).toEqual(["explicit-s"]);
  });

  it("a duplicate session keeps the copy with more turns, whichever root holds it", () => {
    const ws = tmp("tok-ws-");
    const home = tmp("tok-home-");
    const slug = projectSlug(ws);
    const legacy = join(ws, ".claude", "projects");
    writeSession(join(home, ".claude", "projects"), slug, "rich-home", [t("a"), t("b"), t("c")]);
    writeSession(legacy, slug, "rich-home", [t("a")]);
    writeSession(join(home, ".claude", "projects"), slug, "rich-legacy", [t("a")]);
    writeSession(legacy, slug, "rich-legacy", [t("a"), t("b")]);
    const segs = src(ws, { homeDir: home }).collect();
    const turns = Object.fromEntries(segs.map((s) => [s.sessionId, s.turns]));
    expect(turns).toEqual({ "rich-home": 3, "rich-legacy": 2 });
    expect(segs).toHaveLength(2);
  });

  it("a /.claude/worktrees/ path resolves to the main checkout's slug and legacy root", () => {
    const main = tmp("tok-main-");
    const home = tmp("tok-home-");
    const wt = join(main, ".claude", "worktrees", "qa-wt");
    mkdirSync(wt, { recursive: true });
    writeSession(join(home, ".claude", "projects"), projectSlug(main), "home-s", [t("r1")]);
    writeSession(join(main, ".claude", "projects"), projectSlug(main), "legacy-s", [t("r2")]);
    // a transcript dir keyed by the worktree's own slug must never be read
    writeSession(join(home, ".claude", "projects"), wt.replace(/[^A-Za-z0-9]/g, "-"), "wt-own", [t("r3")]);
    const s = src(wt, { homeDir: home });
    expect(s.collect().map((x) => x.sessionId).sort()).toEqual(["home-s", "legacy-s"]);
    expect(s.slug).toBe(projectSlug(main));
  });

  it("resolves a relative workspace path and ignores a trailing slash", () => {
    const ws = tmp("tok-ws-");
    expect(projectSlug(`${ws}/`)).toBe(projectSlug(ws));
    expect(projectSlug(ws)).toBe(ws.replace(/[^A-Za-z0-9]/g, "-"));
    const rel = join(ws, "sub", "..");
    expect(projectSlug(rel)).toBe(projectSlug(ws));
  });

  it("exposes the roots and the slug dirs that exist", () => {
    const ws = tmp("tok-ws-");
    const home = tmp("tok-home-");
    writeSession(join(home, ".claude", "projects"), projectSlug(ws), "home-s", [t("r1")]);
    const s = src(ws, { homeDir: home });
    expect(s.roots).toEqual([join(home, ".claude", "projects"), join(ws, ".claude", "projects")]);
    expect(s.slugDirs()).toEqual([join(home, ".claude", "projects", projectSlug(ws))]);
    expect(resolveTranscriptRoots(ws, { homeDir: home, env: {} })).toEqual(s.roots);
  });
});
