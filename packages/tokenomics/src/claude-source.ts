import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { addTotals, emptyTotals, type Segment, type TokenTotals, type TranscriptSource } from "./types.js";

/** Where a Claude Code workspace's transcripts can be read from. Everything is injectable for tests. */
export interface TranscriptRootsOptions {
  /** Explicit projects dir; replaces both the config dir and the home default. */
  projectsDir?: string;
  /** Stands in for `os.homedir()`. */
  homeDir?: string;
  /** Stands in for `process.env`; only CLAUDE_CONFIG_DIR and OCTOBOTS_TOKENOMICS_PROJECTS_DIR are read. */
  env?: Partial<Record<"CLAUDE_CONFIG_DIR" | "OCTOBOTS_TOKENOMICS_PROJECTS_DIR", string | undefined>>;
}

/**
 * The main checkout for a workspace path. Transcripts are keyed by the MAIN checkout's path, never a
 * worktree's, so a `<main>/.claude/worktrees/<name>` path unwinds to `<main>`. The path is resolved
 * first, so a relative path or a trailing slash cannot yield a different slug.
 */
export function mainCheckoutDir(workspace: string): string {
  const dir = resolve(workspace);
  const wt = dir.indexOf("/.claude/worktrees/");
  return wt !== -1 ? dir.slice(0, wt) : dir;
}

/** Claude Code names a project's transcript dir by replacing every non-[A-Za-z0-9] character with "-". */
export function projectSlug(workspace: string): string {
  return mainCheckoutDir(workspace).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Transcript roots in priority order. Mirrors `tokenomics/collect.mjs` in the Octobots pack:
 *   1. an explicit projects dir (option, else OCTOBOTS_TOKENOMICS_PROJECTS_DIR), else
 *      `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`
 *   2. the legacy repo-local `<main checkout>/.claude/projects`, read in addition
 */
export function resolveTranscriptRoots(workspace: string, opts: TranscriptRootsOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const explicit = opts.projectsDir || env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR;
  const roots = explicit
    ? [explicit]
    : [join(env.CLAUDE_CONFIG_DIR || join(opts.homeDir ?? homedir(), ".claude"), "projects")];
  roots.push(join(mainCheckoutDir(workspace), ".claude", "projects"));
  return [...new Set(roots)];
}

/**
 * Reads Claude Code session transcripts for one workspace: only the workspace's own slug directory,
 * under every root from {@link resolveTranscriptRoots}. The pack CLI (`collect.mjs`) follows the same
 * rules, so both return the same segment ids for the same roots. A session present in two roots
 * counts once: the copy with more turns wins, the earlier root winning ties.
 *
 * Three details dominate correctness here, and all are easy to get silently
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
 *  3. **Read only the own slug.** A root such as `~/.claude/projects` holds every project's sessions.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  readonly agentTool = "claude-code";
  /** The project slug this source reads under each root. */
  readonly slug: string;
  /** The transcript roots, in priority order. */
  readonly roots: string[];

  constructor(repoRoot: string, opts: TranscriptRootsOptions = {}) {
    this.slug = projectSlug(repoRoot);
    this.roots = resolveTranscriptRoots(repoRoot, opts);
  }

  /** The slug directories that exist, i.e. the ones that can contribute. */
  slugDirs(): string[] {
    return this.roots.map((r) => join(r, this.slug)).filter((d) => isDir(d));
  }

  collect(): Segment[] {
    const bySegment = new Map<string, Segment>();
    const add = (s: Segment): void => {
      const prev = bySegment.get(s.segmentId);
      if (!prev || s.turns > prev.turns) bySegment.set(s.segmentId, s);
    };

    for (const slugDir of this.slugDirs()) {
      for (const entry of readdirSync(slugDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.slice(0, -6);

        // Main thread (the orchestrator).
        for (const bucket of aggregate(join(slugDir, entry)).values()) {
          if (bucket.turns === 0) continue;
          add(toSegment(bucket, {
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
            add(toSegment(bucket, {
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
    return [...bySegment.values()];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
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
