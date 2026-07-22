import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { addTotals, emptyTotals, type Segment, type TokenTotals, type TranscriptSource } from "./types.js";

/**
 * Reads Claude Code session transcripts from `<repo>/.claude/projects/`.
 *
 * Two details dominate correctness here, and both are easy to get silently
 * wrong — see the tests:
 *
 *  1. **Deduplicate on `requestId`.** Streaming re-emits the same `usage`
 *     payload across several records. Without this, every token count roughly
 *     doubles.
 *  2. **Walk the subagent tree recursively.** Plain Task subagents sit in
 *     `<session>/subagents/`, but Workflow-tool agents nest under
 *     `<session>/subagents/workflows/wf_<id>/`. A flat read finds a small
 *     fraction of subagent work and silently reports the orchestrator as
 *     having spent 100% of the cost.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  readonly agentTool = "claude-code";

  constructor(private readonly repoRoot: string) {}

  private get projectsDir(): string {
    return join(this.repoRoot, ".claude", "projects");
  }

  collect(): Segment[] {
    if (!existsSync(this.projectsDir)) return [];
    const segments: Segment[] = [];

    for (const slug of readdirSync(this.projectsDir)) {
      const slugDir = join(this.projectsDir, slug);
      if (!statSync(slugDir).isDirectory()) continue;

      for (const entry of readdirSync(slugDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.slice(0, -6);

        // Main thread (the orchestrator).
        for (const bucket of aggregate(join(slugDir, entry)).values()) {
          if (bucket.turns === 0) continue;
          segments.push(toSegment(bucket, {
            segmentId: `${sessionId}:main:${bucket.branch}`,
            sessionId,
            kind: "orchestrator",
            agentType: null,
            workflowId: null,
          }));
        }

        // Subagents — separate files, which is what makes the
        // orchestrator-vs-subagent split exact rather than modelled.
        const subDir = join(slugDir, sessionId, "subagents");
        if (!existsSync(subDir)) continue;
        for (const { dir, file } of walkJsonl(subDir)) {
          const agentId = file.slice(0, -6);
          const meta = readMeta(join(dir, `${agentId}.meta.json`));
          const workflowId = dir.split("/").find((p) => p.startsWith("wf_")) ?? null;
          for (const bucket of aggregate(join(dir, file)).values()) {
            if (bucket.turns === 0) continue;
            segments.push(toSegment(bucket, {
              segmentId: `${sessionId}:${agentId}:${bucket.branch}`,
              sessionId,
              kind: "subagent",
              agentType: meta.agentType ?? null,
              workflowId,
            }));
          }
        }
      }
    }
    return segments;
  }
}

interface Bucket {
  branch: string;
  turns: number;
  tools: Record<string, number>;
  tokensByModel: Record<string, TokenTotals>;
  startedAt: string | null;
  endedAt: string | null;
}

function toSegment(b: Bucket, base: Omit<Segment, keyof Bucket | "tokensByModel" | "tools">): Segment {
  return {
    ...base,
    branch: b.branch,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    turns: b.turns,
    tokensByModel: b.tokensByModel,
    tools: b.tools,
  };
}

function readMeta(path: string): { agentType?: string } {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { agentType?: string };
  } catch {
    return {};
  }
}

/** Every `*.jsonl` beneath `root`, at any depth. */
function* walkJsonl(root: string): Generator<{ dir: string; file: string }> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith(".jsonl")) yield { dir: root, file: entry.name };
  }
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/**
 * Aggregate one transcript into per-branch buckets. One long session spans many
 * branches, so buckets are per-branch rather than per-file.
 */
function aggregate(file: string): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return buckets;
  }

  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated tail line is normal on a live session
    }
    if (rec.type !== "assistant") continue;
    const msg = rec.message as { model?: string; usage?: RawUsage; content?: unknown[] } | undefined;
    if (!msg) continue;

    const branch = (rec.gitBranch as string) || "(none)";
    let b = buckets.get(branch);
    if (!b) {
      b = { branch, turns: 0, tools: {}, tokensByModel: {}, startedAt: null, endedAt: null };
      buckets.set(branch, b);
    }

    const requestId = rec.requestId as string | undefined;
    if (requestId) {
      if (seen.has(requestId)) continue; // streaming duplicate — same usage, already counted
      seen.add(requestId);
    }

    b.turns += 1;
    const ts = rec.timestamp as string | undefined;
    if (ts) {
      if (!b.startedAt || ts < b.startedAt) b.startedAt = ts;
      if (!b.endedAt || ts > b.endedAt) b.endedAt = ts;
    }

    const model = msg.model ?? "(unknown)";
    const u = msg.usage ?? {};
    const cc = u.cache_creation;
    const created = u.cache_creation_input_tokens ?? 0;
    b.tokensByModel[model] = addTotals(b.tokensByModel[model] ?? emptyTotals(), {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreate: created,
      // Absent breakdown: attribute the whole write to the cheaper 5m bucket so
      // an unknown split can never inflate the reported cost.
      cacheCreate5m: cc ? (cc.ephemeral_5m_input_tokens ?? 0) : created,
      cacheCreate1h: cc ? (cc.ephemeral_1h_input_tokens ?? 0) : 0,
    });

    for (const block of msg.content ?? []) {
      const c = block as { type?: string; name?: string };
      if (c?.type === "tool_use" && c.name) b.tools[c.name] = (b.tools[c.name] ?? 0) + 1;
    }
  }
  return buckets;
}
