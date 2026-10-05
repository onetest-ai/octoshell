import { readFileSync } from "node:fs";
import type { Segment, TokenTotals, TranscriptSource } from "../../src/types.js";

interface RawTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
}

interface RawSegment {
  segment_id: string;
  session_id: string;
  kind: "orchestrator" | "subagent";
  agent_type: string | null;
  workflow_id?: string | null;
  branch: string;
  started_at: string | null;
  ended_at: string | null;
  turns: number;
  tokens_by_model: Record<string, RawTokens>;
  tools?: Record<string, number>;
}

const totals = (t: RawTokens): TokenTotals => ({
  input: t.input_tokens ?? 0,
  output: t.output_tokens ?? 0,
  cacheRead: t.cache_read_input_tokens ?? 0,
  cacheCreate: t.cache_creation_input_tokens ?? 0,
  cacheCreate5m: t.cache_creation_5m_tokens ?? 0,
  cacheCreate1h: t.cache_creation_1h_tokens ?? 0,
});

/** The pack's `raw/segments.jsonl` (snake_case) as the extension's `Segment`s, so both rollups read one file. */
export function jsonlSource(file: string): TranscriptSource {
  return {
    agentTool: "claude-code",
    collect: () =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as RawSegment)
        .map(
          (r): Segment => ({
            segmentId: r.segment_id,
            sessionId: r.session_id,
            kind: r.kind,
            agentType: r.agent_type,
            workflowId: r.workflow_id ?? null,
            branch: r.branch,
            startedAt: r.started_at,
            endedAt: r.ended_at,
            turns: r.turns,
            tokensByModel: Object.fromEntries(Object.entries(r.tokens_by_model).map(([m, t]) => [m, totals(t)])),
            tools: r.tools ?? {},
          }),
        ),
  };
}
