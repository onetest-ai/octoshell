import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyEstimate, type Estimate, type WorkLogEntry } from "./types.js";

/**
 * Parse the `## Tokenomics` block a planner authors on a board file:
 *
 *   ## Tokenomics
 *   effort_days: 3
 *   size_tshirt: M
 *   complexity_score: 18
 *
 * Effort is the sizing key and cannot be recovered after the fact — nothing in
 * a transcript, diff or PR reveals how long work would have taken a person. So
 * this reads what a human wrote; it never infers.
 */
export function parseEstimateBlock(text: string): Estimate {
  const est = emptyEstimate();

  // The terminator must be end-of-INPUT, not end-of-line: under the `/m` flag
  // needed for `^##`, a bare `$` makes the lazy body stop at the first newline
  // and silently truncate the block to one line.
  const block = /^##[ \t]+Tokenomics[ \t]*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(text)?.[1];
  if (!block) return est;

  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const m = /^\s*[-*]?\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (m?.[1] && m[2] !== undefined) fields.set(m[1].toLowerCase(), m[2]);
  }

  const num = (key: string): number | null => {
    const raw = fields.get(key);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  est.effortDays = num("effort_days");
  est.complexityScore = num("complexity_score");
  est.sizeTshirt = fields.get("size_tshirt") ?? null;
  est.selfSize = fields.get("self_size") ?? null;
  est.maturity = fields.get("maturity") ?? null;
  est.estimatedRetrospectively = fields.get("estimated_retrospectively") === "true";
  est.branches = (fields.get("branches") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return est;
}

/** Read the estimate off an entity folder (`<folderPath>/<file>.md`). */
export function readEstimate(folderPath: string, file: "mission.md" | "task.md"): Estimate {
  const path = join(folderPath, file);
  if (!existsSync(path)) return emptyEstimate();
  try {
    return parseEstimateBlock(readFileSync(path, "utf8"));
  } catch {
    return emptyEstimate();
  }
}

/**
 * The work log written by `.octobots/hooks/work-log.mjs`: session -> task,
 * recorded at the moment a status flipped.
 *
 * A recorded fact beats inferring a task from a branch name, so the rollup
 * consults this first. Keyed both with and without the branch: the
 * branch-qualified key wins when one session touched several tasks; the bare
 * session key covers work whose branch changed mid-task.
 */
export function loadWorkLog(repoRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  const path = join(repoRoot, ".octobots", "tokenomics", "worklog.jsonl");
  if (!existsSync(path)) return index;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return index;
  }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: WorkLogEntry;
    try {
      e = JSON.parse(line) as WorkLogEntry;
    } catch {
      continue; // skip a corrupt line rather than losing the whole log
    }
    if (!e.sessionId && !(e as unknown as { session_id?: string }).session_id) continue;
    const sessionId = e.sessionId ?? (e as unknown as { session_id: string }).session_id;
    if (!e.task) continue; // mission-level entries don't refine task attribution
    if (e.branch) index.set(`${sessionId}|${e.branch}`, e.task);
    index.set(sessionId, e.task);
  }
  return index;
}
