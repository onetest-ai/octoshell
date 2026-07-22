import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeTranscriptSource } from "../src/claude-source.js";

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

function repo(lines: string[], subagents: { path: string; agentType?: string; line: string }[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "tok-src-"));
  const proj = join(root, ".claude", "projects", "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${SESSION}.jsonl`), lines.join("\n") + "\n");
  for (const s of subagents) {
    const dir = join(proj, SESSION, "subagents", s.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-x.jsonl"), s.line + "\n");
    if (s.agentType) {
      writeFileSync(join(dir, "agent-x.meta.json"), JSON.stringify({ agentType: s.agentType }));
    }
  }
  return root;
}

describe("ClaudeTranscriptSource", () => {
  // Streaming re-emits the same usage payload; without dedupe every count doubles.
  it("counts a request once even when streaming repeats its usage payload", () => {
    const root = repo([
      turn({ branch: "feat/x", requestId: "req-1" }),
      turn({ branch: "feat/x", requestId: "req-1" }),
      turn({ branch: "feat/x", requestId: "req-2" }),
    ]);
    const [seg] = new ClaudeTranscriptSource(root).collect();
    expect(seg!.turns).toBe(2);
    expect(seg!.tokensByModel["claude-sonnet-5"]!.output).toBe(200);
  });

  it("splits one session into a segment per branch", () => {
    const root = repo([
      turn({ branch: "feat/a", requestId: "r1" }),
      turn({ branch: "feat/b", requestId: "r2" }),
    ]);
    expect(new ClaudeTranscriptSource(root).collect().map((s) => s.branch).sort()).toEqual([
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
    const segs = new ClaudeTranscriptSource(root).collect();
    const subs = segs.filter((s) => s.kind === "subagent");
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.agentType).sort()).toEqual(["js-dev", "python-dev"]);
    expect(subs.find((s) => s.agentType === "js-dev")!.workflowId).toBe("wf_abc");
  });

  it("keeps the 5m/1h cache-write split, which bill at different rates", () => {
    const root = repo([turn({ branch: "feat/x", requestId: "r1", create5m: 300, create1h: 700 })]);
    const t = new ClaudeTranscriptSource(root).collect()[0]!.tokensByModel["claude-sonnet-5"]!;
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
    const t = new ClaudeTranscriptSource(repo([line])).collect()[0]!.tokensByModel["claude-sonnet-5"]!;
    expect(t.cacheCreate5m).toBe(500);
    expect(t.cacheCreate1h).toBe(0);
  });

  it("counts tool calls and survives a truncated tail line", () => {
    const root = repo([turn({ branch: "feat/x", requestId: "r1", tool: "Edit" }), '{"type":"assist']);
    const [seg] = new ClaudeTranscriptSource(root).collect();
    expect(seg!.tools["Edit"]).toBe(1);
  });

  it("returns nothing when the repo has no transcripts", () => {
    expect(new ClaudeTranscriptSource(mkdtempSync(join(tmpdir(), "tok-empty-"))).collect()).toEqual([]);
  });
});
