import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

/** The environment without git's location variables: a hook exports GIT_DIR, and it outranks any cwd. */
function gitFreeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: gitFreeEnv(),
    });
  } catch {
    return null; // no git, not a repository, or the directory is gone
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const WT = /(?:^|\/)(?:\.claude\/worktrees|\.worktrees)(?:\/|$)/;

/** `<main>/.claude/worktrees/<name>` and `<main>/.worktrees/<name>` -> `<main>`, by path alone. */
function mainByPath(dir: string): string {
  const m = dir.match(WT);
  return m?.index ? dir.slice(0, m.index) : dir;
}

function commonDir(dir: string): string | null {
  const out = git(dir, "rev-parse", "--git-common-dir");
  return out ? real(resolve(dir, out.trim())) : null;
}

/**
 * A workspace's main checkout and its other registered worktrees. Twin of `projectCheckouts` in the
 * pack's `tokenomics/checkouts.mjs`, whose comments hold the reasons.
 */
export function projectCheckouts(workspace: string): { mainDir: string; worktrees: string[]; sub: string } {
  const dir = resolve(workspace);
  const byPath = mainByPath(dir);
  const [top, gitDir, commonRel] =
    git(dir, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir")?.split("\n") ?? [];
  if (!top || !gitDir || !commonRel) return { mainDir: byPath, worktrees: [], sub: "" };
  let sub = relative(real(top), real(dir));
  const common = real(resolve(dir, commonRel));
  const list = (git(dir, "worktree", "list", "--porcelain") ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  let mainDir = dir;
  if (common === real(gitDir)) {
    const at = sub.match(WT)?.index;
    if (at !== undefined) {
      const tail = sub.slice(at);
      mainDir = dir.endsWith(tail) ? dir.slice(0, -tail.length).replace(/\/$/, "") : join(top, sub.slice(0, at));
      sub = sub.slice(0, at);
    }
  } else if (list[0] && existsSync(join(list[0], ".git")) && commonDir(list[0]) === common) {
    const first = join(list[0], sub);
    mainDir = real(byPath) === real(first) ? byPath : first;
  }
  const worktrees = list
    .slice(1)
    .filter((w) => !existsSync(w) || commonDir(w) === common)
    .map((w) => join(w, sub))
    .filter((w) => real(w) !== real(mainDir));
  return { mainDir, worktrees, sub };
}

/** The main checkout for a workspace path: git decides, the path is the fallback. */
export function mainCheckoutDir(workspace: string): string {
  return projectCheckouts(workspace).mainDir;
}

const slugOf = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, "-");

/** Claude Code names a project's transcript dir by replacing every non-[A-Za-z0-9] character with "-". */
export function projectSlug(workspace: string): string {
  return slugOf(mainCheckoutDir(workspace));
}

/**
 * Transcript roots in priority order. Mirrors `tokenomics/collect.mjs` in the Octobots pack:
 *   1. an explicit projects dir (option, else OCTOBOTS_TOKENOMICS_PROJECTS_DIR), else
 *      `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`
 *   2. the legacy repo-local `<main checkout>/.claude/projects`, read in addition
 */
export function resolveTranscriptRoots(workspace: string, opts: TranscriptRootsOptions = {}): string[] {
  return rootsFor(mainCheckoutDir(workspace), opts);
}

function rootsFor(mainDir: string, opts: TranscriptRootsOptions): string[] {
  const env = opts.env ?? process.env;
  const explicit = opts.projectsDir || env.OCTOBOTS_TOKENOMICS_PROJECTS_DIR;
  const roots = explicit
    ? [explicit]
    : [join(env.CLAUDE_CONFIG_DIR || join(opts.homeDir ?? homedir(), ".claude"), "projects")];
  roots.push(join(mainDir, ".claude", "projects"));
  return [...new Set(roots)];
}

/**
 * Reads Claude Code session transcripts for one workspace: only the workspace's own slug directories
 * (main checkout and worktrees), under every root from {@link resolveTranscriptRoots}. The pack CLI (`collect.mjs`) follows the same
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
 *  3. **Read only the own slugs.** A root such as `~/.claude/projects` holds every project's sessions.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  readonly agentTool = "claude-code";
  /** The project slug this source reads under each root. */
  readonly slug: string;
  /** The transcript roots, in priority order. */
  readonly roots: string[];
  private readonly mainDir: string;
  private readonly worktrees: string[];
  private readonly sub: string;

  constructor(repoRoot: string, opts: TranscriptRootsOptions = {}) {
    const { mainDir, worktrees, sub } = projectCheckouts(repoRoot);
    this.mainDir = mainDir;
    this.worktrees = worktrees;
    this.sub = sub;
    this.slug = slugOf(mainDir);
    this.roots = rootsFor(mainDir, opts);
  }

  /** The slug directories that contribute at least one session. */
  slugDirs(): string[] {
    return [...new Set(this.sessions().map((x) => x.dir))];
  }

  /** Every session transcript of the project. Twin of `listSessions` in the pack's checkouts.mjs. */
  private sessions(): TranscriptRef[] {
    const same = (a: string, b: string): boolean => a === b || real(a) === real(b);
    const { mainDir, sub, slug } = this;
    const bySlug = new Map<string, string[]>();
    for (const w of this.worktrees) {
      const k = slugOf(w);
      if (k !== slug) bySlug.set(k, [...(bySlug.get(k) ?? []), w]);
    }
    const top = sub ? resolve(mainDir, relative(sub, "")) : mainDir;
    const parents = [
      ...new Set([top, real(top)].flatMap((t) => [join(t, ".worktrees"), join(t, ".claude", "worktrees")])),
    ];
    const out: TranscriptRef[] = [];
    for (const root of this.roots) {
      const add = (name: string, isMain: boolean, accept: (cwd: string | null) => boolean): void => {
        const dir = join(root, name);
        for (const e of entries(dir)) {
          if (!e.endsWith(".jsonl") || !accept(firstCwd(join(dir, e)))) continue;
          out.push({ dir, sessionId: e.slice(0, -6), isMain });
        }
      };
      if (!isDir(root)) continue;
      add(slug, true, (cwd) => cwd === null || slugOf(cwd) !== slug || !existsSync(cwd) || same(cwd, mainDir));
      for (const [k, dirs] of bySlug) {
        add(k, false, (cwd) => cwd !== null && (same(cwd, mainDir) || dirs.some((d) => same(d, cwd))));
      }
      for (const name of entries(root)) {
        if (name === slug || bySlug.has(name)) continue;
        if (!parents.some((p) => name.startsWith(`${slugOf(p)}-`))) continue;
        add(name, false, (cwd) => {
          if (cwd === null || slugOf(cwd) !== name || (sub && !cwd.endsWith(`/${sub}`))) return false;
          const wt = sub ? cwd.slice(0, -sub.length - 1) : cwd;
          return parents.includes(dirname(wt)) && !existsSync(wt);
        });
      }
    }
    return out;
  }

  collect(): Segment[] {
    // A session can be in two slugs, as a copy or split by a move into a worktree. Per thread the fuller
    // class counts (main winning ties), plus whatever requests only the other one holds.
    type Side = { segs: Map<string, Segment>; ids: Set<string>; files: { file: string; base: (branch: string) => SegmentBase }[] };
    const side = (): Side => ({ segs: new Map(), ids: new Set(), files: [] });
    const scopes = new Map<string, { main: Side; wt: Side }>();
    let cls: "main" | "wt" = "main";
    const addFile = (file: string, base: (branch: string) => SegmentBase): void => {
      for (const bucket of aggregate(file).values()) {
        if (bucket.turns === 0) continue;
        const s = toSegment(bucket, base(bucket.branch));
        const scope = s.segmentId.split(":").slice(0, 2).join(":");
        let c = scopes.get(scope);
        if (!c) scopes.set(scope, (c = { main: side(), wt: side() }));
        const own = c[cls];
        for (const id of bucket.ids) own.ids.add(id);
        if (!own.files.some((f) => f.file === file)) own.files.push({ file, base });
        const prev = own.segs.get(s.segmentId);
        if (!prev || s.turns > prev.turns) own.segs.set(s.segmentId, s);
      }
    };

    for (const { dir: slugDir, sessionId, isMain } of this.sessions()) {
      cls = isMain ? "main" : "wt";
      // Main thread (the orchestrator).
      addFile(join(slugDir, `${sessionId}.jsonl`), (branch) => ({
        segmentId: `${sessionId}:main:${branch}`,
        sessionId,
        kind: "orchestrator",
        agentType: null,
        workflowId: null,
      }));

      // Subagents — separate files, which is what makes the
      // orchestrator-vs-subagent split exact rather than modelled.
      const subDir = join(slugDir, sessionId, "subagents");
      if (!existsSync(subDir)) continue;
      for (const { dir, file } of walkJsonl(subDir)) {
        const agentId = file.slice(0, -6);
        const meta = readMeta(join(dir, `${agentId}.meta.json`));
        const workflowId = dir.split("/").find((p) => p.startsWith("wf_")) ?? null;
        addFile(join(dir, file), (branch) => ({
          segmentId: `${sessionId}:${agentId}:${branch}`,
          sessionId,
          kind: "subagent",
          agentType: meta.agentType ?? null,
          workflowId,
        }));
      }
    }
    const size = (x: Side): number => [...x.segs.values()].reduce((t, g) => t + g.turns, 0);
    return [...scopes.values()].flatMap(({ main, wt }) => {
      const [win, lose] = size(wt) > size(main) ? [wt, main] : [main, wt];
      for (const { file, base } of lose.files) {
        for (const bucket of aggregate(file, win.ids).values()) {
          if (bucket.turns === 0) continue;
          for (const id of bucket.ids) win.ids.add(id);
          const s = toSegment(bucket, base(bucket.branch));
          const prev = win.segs.get(s.segmentId);
          win.segs.set(s.segmentId, prev ? addSegments(prev, s) : s);
        }
      }
      return [...win.segs.values()];
    });
  }
}

interface TranscriptRef {
  dir: string;
  sessionId: string;
  isMain: boolean;
}

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** The first `cwd` a transcript records, or null. Reads only as far as it must. */
function firstCwd(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(1 << 16);
    let parts: Buffer[] = [];
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      const chunk = Buffer.from(buf.subarray(0, n));
      let at = 0;
      for (;;) {
        const nl = chunk.indexOf(10, at);
        if (nl === -1 && n > 0) break;
        const line = Buffer.concat([...parts, chunk.subarray(at, nl === -1 ? n : nl)]).toString("utf8");
        parts = [];
        if (line.includes('"cwd"')) {
          try {
            const d = JSON.parse(line) as { cwd?: unknown } | null;
            if (typeof d?.cwd === "string" && d.cwd) return d.cwd;
          } catch {
            // not a whole record
          }
        }
        if (nl === -1) return null;
        at = nl + 1;
      }
      parts.push(chunk.subarray(at));
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
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
  ids: string[];
  turns: number;
  tools: Record<string, number>;
  tokensByModel: Record<string, TokenTotals>;
  startedAt: string | null;
  endedAt: string | null;
}

type SegmentBase = Omit<Segment, keyof Bucket>;

/** Two parts of one segment, with no request in common. */
function addSegments(a: Segment, b: Segment): Segment {
  const tokensByModel = { ...a.tokensByModel };
  for (const [m, t] of Object.entries(b.tokensByModel)) tokensByModel[m] = addTotals(tokensByModel[m] ?? emptyTotals(), t);
  const tools = { ...a.tools };
  for (const [k, n] of Object.entries(b.tools)) tools[k] = (tools[k] ?? 0) + n;
  const times = (k: "startedAt" | "endedAt"): string[] => [a[k], b[k]].filter((x): x is string => !!x).sort();
  return {
    ...a,
    startedAt: times("startedAt")[0] ?? null,
    endedAt: times("endedAt").at(-1) ?? null,
    turns: a.turns + b.turns,
    tokensByModel,
    tools,
  };
}

function toSegment(b: Bucket, base: SegmentBase): Segment {
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
function aggregate(file: string, skip?: Set<string>): Map<string, Bucket> {
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
      b = { branch, ids: [], turns: 0, tools: {}, tokensByModel: {}, startedAt: null, endedAt: null };
      buckets.set(branch, b);
    }

    const requestId = rec.requestId as string | undefined;
    if (skip && (!requestId || skip.has(requestId))) continue;
    if (requestId) {
      if (seen.has(requestId)) continue; // streaming duplicate — same usage, already counted
      seen.add(requestId);
    }

    if (requestId) b.ids.push(requestId);
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
