import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { installTokenomics } from "../src/host/octobots-tokenomics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "..", "resources", "octobots-pack");
const FAKE = join(HERE, "fixtures", "fake-ccusage.mjs");
const TOK_SRC = join(PACK, "tokenomics");
const REAL_CANDIDATES = [
  process.env.OCTOBOTS_REAL_CCUSAGE,
  join(HERE, "..", "..", "..", ".octobots", "tools", "node_modules", ".bin", "ccusage"),
].filter((p): p is string => !!p);
const REAL = REAL_CANDIDATES.find((p) => existsSync(p));

const MODEL = "claude-sonnet-4-5-20250929";

interface Fixture {
  home: string;
  repo: string;
  slug: string;
  homeSlugDir: string;
  legacySlugDir: string;
  tok: string;
}

function fixture(): Fixture {
  const base = realpathSync(mkdtempClean("verify-roots-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const slug = repo.replace(/[^A-Za-z0-9]/g, "-");
  installTokenomics(PACK, repo);
  return {
    home, repo, slug,
    homeSlugDir: join(home, ".claude", "projects", slug),
    legacySlugDir: join(repo, ".claude", "projects", slug),
    tok: join(repo, ".octobots", "tokenomics"),
  };
}

/** Writes one session of `turns` assistant records into `<slugDir>/<id>.jsonl`. */
function session(slugDir: string, id: string, turns: number, opts: { subagent?: boolean; workflow?: number } = {}): void {
  mkdirSync(slugDir, { recursive: true });
  const rec = (n: number, tag: string) => JSON.stringify({
    type: "assistant", sessionId: id, gitBranch: "main", timestamp: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`,
    requestId: `req-${tag}-${n}`,
    message: { model: MODEL, content: [], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000 } },
  });
  const lines = Array.from({ length: turns }, (_, n) => rec(n, id));
  writeFileSync(join(slugDir, `${id}.jsonl`), lines.join("\n") + "\n");
  if (opts.subagent) {
    const sub = join(slugDir, id, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a.jsonl"), rec(0, `${id}-sub`) + "\n");
  }
  if (opts.workflow) {
    // A Workflow-tool agent: real ccusage 20.0.18 reports it as its OWN row keyed `wf_<id>`, not under
    // the session, so a session-id-only filter drops it (measured on solo: 1.7B cache_read tokens).
    const wf = join(slugDir, id, "subagents", "workflows", `wf_${id}`);
    mkdirSync(wf, { recursive: true });
    const lines = Array.from({ length: opts.workflow }, (_, n) => rec(n, `${id}-wf`));
    writeFileSync(join(wf, "agent-w.jsonl"), lines.join("\n") + "\n");
  }
}

function node(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, timeout: 120_000 });
}

function baseEnv(f: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: f.home, USERPROFILE: f.home, ...extra };
}

/** collect -> rollup, the pipeline run.mjs drives, with the isolated env. */
function pipeline(f: Fixture, env: Record<string, string>): void {
  for (const [script, extra] of [["collect.mjs", []], ["rollup.mjs", ["--no-gh"]]] as const) {
    const r = node(join(f.tok, script), ["--project-dir", f.repo, "--quiet", ...extra], env);
    expect(r.status, `${script}: ${r.stderr}`).toBe(0);
  }
}

function verify(f: Fixture, extra: Record<string, string> = {}, bin: string = FAKE) {
  const env = baseEnv(f, { OCTOBOTS_CCUSAGE_BIN: bin, ...extra });
  pipeline(f, env);
  return node(join(f.tok, "verify.mjs"), ["--project-dir", f.repo], env);
}

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("tokenomics verify.mjs reads the collector's transcript roots", () => {
  it("home-only session + EMPTY legacy root -> PASS (regression: was a 100% FAIL)", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-home", 5, { subagent: true });
    mkdirSync(f.legacySlugDir, { recursive: true }); // legacy slug dir exists but holds nothing
    const r = verify(f);
    expect(out(r)).toContain("all gated fields within");
    expect(r.status, out(r)).toBe(0);
  });

  it("home-only session + NO legacy root -> PASS, never 'needs network access' (regression: was exit 2)", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-home", 5);
    expect(existsSync(join(f.repo, ".claude"))).toBe(false);
    const r = verify(f);
    expect(out(r)).not.toMatch(/network/i);
    expect(r.status, out(r)).toBe(0);
  });

  it("another project's slug in the same root is filtered out -> PASS", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-mine", 4);
    session(join(f.home, ".claude", "projects", "-some-other-project"), "s-theirs", 40);
    const r = verify(f);
    expect(r.status, out(r)).toBe(0);
  });

  it("same session in home and legacy roots (legacy has fewer turns) -> PASS", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-dup", 8);
    session(f.legacySlugDir, "s-dup", 3);
    const r = verify(f);
    expect(r.status, out(r)).toBe(0);
  });

  it("a session only in the legacy root is read as well -> PASS", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-home", 4);
    session(f.legacySlugDir, "s-legacy", 6);
    const r = verify(f);
    expect(out(r)).toMatch(/matched: 2\/2/);
    expect(r.status, out(r)).toBe(0);
  });

  it("CLAUDE_CONFIG_DIR=X -> ccusage is staged on X/projects, never ~/.claude/projects", () => {
    const f = fixture();
    const cfg = join(realpathSync(mkdtempClean("verify-cfg-")), "cfg");
    session(join(cfg, "projects", f.slug), "s-cfg", 5);
    session(f.homeSlugDir, "s-decoy-home", 50); // must NOT be read: CLAUDE_CONFIG_DIR replaces ~/.claude
    const log = join(f.repo, "fake.log");
    const r = verify(f, { CLAUDE_CONFIG_DIR: cfg, FAKE_CCUSAGE_LOG: log });
    expect(r.status, out(r)).toBe(0);
    const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop()!);
    expect(call.argv).toEqual(["session", "--json", "--offline"]);
    expect(call.resolved).toEqual([realpathSync(join(cfg, "projects"))]);
    expect(call.CLAUDE_CONFIG_DIR).not.toContain(join(f.home, ".claude"));
  });

  it("a symlinked slug dir is read -> PASS", () => {
    const f = fixture();
    const real = join(realpathSync(mkdtempClean("verify-real-")), "elsewhere", "real-slug");
    session(real, "s-linked", 5);
    mkdirSync(dirname(f.homeSlugDir), { recursive: true });
    symlinkSync(real, f.homeSlugDir);
    const r = verify(f);
    expect(out(r)).toMatch(/matched: 1\/1/);
    expect(r.status, out(r)).toBe(0);
  });

  it("a session on disk that the collector missed -> FAIL exit 1 (verify still catches a collector miss)", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-collected", 4);
    const env = baseEnv(f, { OCTOBOTS_CCUSAGE_BIN: FAKE });
    pipeline(f, env);
    session(f.homeSlugDir, "s-late", 30); // appears after collection
    const r = node(join(f.tok, "verify.mjs"), ["--project-dir", f.repo], env);
    expect(r.status, out(r)).toBe(1);
    expect(out(r)).toContain("FAIL");
  });

  it("a collected session since pruned from disk -> tokens PASS, cost shown as info", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-kept", 4);
    session(f.homeSlugDir, "s-pruned", 9);
    const env = baseEnv(f, { OCTOBOTS_CCUSAGE_BIN: FAKE });
    pipeline(f, env);
    rmSync(join(f.homeSlugDir, "s-pruned.jsonl"));
    const r = node(join(f.tok, "verify.mjs"), ["--project-dir", f.repo], env);
    expect(r.status, out(r)).toBe(0);
    expect(out(r)).toMatch(/no longer on disk/);
    expect(out(r)).toMatch(/info\s+cost/);
  });

  it("no transcripts anywhere -> exit 2 'no transcripts for slug', no network wording", () => {
    const bare = fixture();
    mkdirSync(join(bare.tok, "raw"), { recursive: true });
    writeFileSync(join(bare.tok, "runs.json"), JSON.stringify({ runs: [], unattributed: { tokens: {}, cost_api_equivalent_usd: 0 } }));
    writeFileSync(join(bare.tok, "raw", "segments.jsonl"), "");
    const r2 = node(join(bare.tok, "verify.mjs"), ["--project-dir", bare.repo], baseEnv(bare, { OCTOBOTS_CCUSAGE_BIN: FAKE }));
    expect(r2.status, out(r2)).toBe(2);
    expect(out(r2)).toContain(`no transcripts for slug ${bare.slug}`);
    expect(out(r2)).not.toMatch(/network/i);
  });

  it("ccusage binary fails -> exit 2 'ccusage failed', no network wording", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-home", 4);
    const r = verify(f, { FAKE_CCUSAGE_FAIL: "1" });
    expect(r.status, out(r)).toBe(2);
    expect(out(r)).toContain("ccusage failed");
    expect(out(r)).not.toMatch(/network/i);
  });

  it("Workflow-tool agents (subagents/workflows/wf_*) count toward their session's population -> PASS", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-wf", 3, { subagent: true, workflow: 20 });
    const r = verify(f);
    expect(out(r)).toMatch(/matched: 1\/1/);
    expect(r.status, out(r)).toBe(0);
  });

  it("nothing pruned -> cost IS gated: a cost-only mismatch FAILs (the pruned-session escape is not always on)", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-home", 5);
    const env = baseEnv(f, { OCTOBOTS_CCUSAGE_BIN: FAKE });
    pipeline(f, env);
    const runsFile = join(f.tok, "runs.json");
    const runs = JSON.parse(readFileSync(runsFile, "utf8"));
    for (const r of runs.runs) r.cost_api_equivalent_usd *= 2; // tokens untouched: only cost can trip
    runs.unattributed.cost_api_equivalent_usd *= 2;
    writeFileSync(runsFile, JSON.stringify(runs));
    const r = node(join(f.tok, "verify.mjs"), ["--project-dir", f.repo], env);
    expect(out(r)).toMatch(/FAIL cost/);
    expect(out(r)).not.toMatch(/no longer on disk/);
    expect(r.status, out(r)).toBe(1);
  });

  it("run from a worktree -> reads the MAIN checkout's slug -> PASS", () => {
    const f = fixture();
    session(f.homeSlugDir, "s-home", 5);
    const wt = join(f.repo, ".claude", "worktrees", "qa-wt");
    mkdirSync(wt, { recursive: true });
    installTokenomics(PACK, wt);
    const env = baseEnv(f, { OCTOBOTS_CCUSAGE_BIN: FAKE });
    const wtTok = join(wt, ".octobots", "tokenomics");
    for (const [script, extra] of [["collect.mjs", []], ["rollup.mjs", ["--no-gh"]]] as const) {
      const p = node(join(wtTok, script), ["--project-dir", wt, "--quiet", ...extra], env);
      expect(p.status, `${script}: ${p.stderr}`).toBe(0);
    }
    const r = node(join(wtTok, "verify.mjs"), ["--project-dir", wt], env);
    expect(out(r)).toMatch(/matched: 1\/1/);
    expect(r.status, out(r)).toBe(0);
  });

  it("the staging temp dir is removed on success AND on ccusage failure, and the roots are left intact", () => {
    for (const fail of [false, true]) {
      const f = fixture();
      session(f.homeSlugDir, "s-home", 5, { subagent: true });
      const tmp = join(realpathSync(mkdtempClean("verify-tmp-")), "t");
      mkdirSync(tmp);
      const before = readdirSync(f.homeSlugDir, { recursive: true }).map(String).sort();
      const r = verify(f, { TMPDIR: tmp, ...(fail ? { FAKE_CCUSAGE_FAIL: "1" } : {}) });
      expect(r.status, out(r)).toBe(fail ? 2 : 0);
      expect(readdirSync(tmp), `leftover staging after ${fail ? "failure" : "success"}`).toEqual([]);
      expect(readdirSync(f.homeSlugDir, { recursive: true }).map(String).sort()).toEqual(before);
    }
  });

  // Skipped ONLY when the real binary is genuinely absent (not installed under .octobots/tools and no
  // OCTOBOTS_REAL_CCUSAGE): the skip is environmental, not a deferral.
  describe.skipIf(!REAL)("against the real ccusage binary", () => {
    it("home-only + bare legacy root -> PASS", () => {
      const f = fixture();
      session(f.homeSlugDir, "s-home", 5, { subagent: true });
      mkdirSync(f.legacySlugDir, { recursive: true });
      const r = verify(f, {}, REAL!);
      expect(r.status, out(r)).toBe(0);
    });

    it("home-only + no legacy root -> PASS, no network wording", () => {
      const f = fixture();
      session(f.homeSlugDir, "s-home", 5);
      const r = verify(f, {}, REAL!);
      expect(out(r)).not.toMatch(/network/i);
      expect(r.status, out(r)).toBe(0);
    });

    it("Workflow-tool agents under subagents/workflows -> PASS (real ccusage keys them as wf_<id> rows)", () => {
      const f = fixture();
      session(f.homeSlugDir, "s-wf", 3, { subagent: true, workflow: 20 });
      const r = verify(f, {}, REAL!);
      expect(r.status, out(r)).toBe(0);
    });

    it("symlinked slug dir -> PASS", () => {
      const f = fixture();
      const real = join(realpathSync(mkdtempClean("verify-real-")), "elsewhere", "real-slug");
      session(real, "s-linked", 5);
      mkdirSync(dirname(f.homeSlugDir), { recursive: true });
      symlinkSync(real, f.homeSlugDir);
      const r = verify(f, {}, REAL!);
      expect(r.status, out(r)).toBe(0);
    });
  });
});

// The population rule (roots, slug, worktree unwinding) is ONE module that both scripts import; a
// second spelling of it in either script is exactly the drift this file exists to catch.
describe("tokenomics roots.mjs is the single population rule", () => {
  it("collect.mjs and verify.mjs both import it and neither re-spells the rule", () => {
    for (const script of ["collect.mjs", "verify.mjs"]) {
      const src = readFileSync(join(TOK_SRC, script), "utf8");
      expect(src, script).toMatch(/import \{[^}]*\blocateTranscripts\b[^}]*\} from "\.\/roots\.mjs";/);
      expect(src, script).toMatch(/\blocateTranscripts\(args\)/);
      expect(src, `${script} re-spells the slug rule`).not.toContain("[^A-Za-z0-9]");
      expect(src, `${script} re-spells the worktree unwind`).not.toContain("/.claude/worktrees/");
      expect(src, `${script} re-spells the roots`).not.toMatch(/env\.OCTOBOTS_TOKENOMICS_PROJECTS_DIR|homedir\(/);
    }
  });

  it("is installed next to the scripts that import it", () => {
    const f = fixture();
    expect(existsSync(join(f.tok, "roots.mjs"))).toBe(true);
  });

  it("locateTranscripts: worktree unwinding, slug, root precedence and dedupe", async () => {
    const roots = (await import(join(TOK_SRC, "roots.mjs"))) as {
      locateTranscripts: (argv: string[], env: Record<string, string | undefined>, cwd?: string) =>
        { projectDir: string; mainDir: string; slug: string; roots: string[] };
    };
    const wt = roots.locateTranscripts(["--project-dir", "/w/my_repo/.claude/worktrees/x/"], { CLAUDE_CONFIG_DIR: "/cfg" });
    expect(wt.projectDir).toBe("/w/my_repo/.claude/worktrees/x");
    expect(wt.mainDir).toBe("/w/my_repo");
    expect(wt.slug).toBe("-w-my-repo");
    expect(wt.roots).toEqual(["/cfg/projects", "/w/my_repo/.claude/projects"]);
    const explicit = roots.locateTranscripts(["--projects-dir", "/w/r/.claude/projects"], { CLAUDE_PROJECT_DIR: "/w/r", CLAUDE_CONFIG_DIR: "/cfg" });
    expect(explicit.roots).toEqual(["/w/r/.claude/projects"]);
    const viaEnv = roots.locateTranscripts([], { OCTOBOTS_TOKENOMICS_PROJECTS_DIR: "/x" }, "/w/r");
    expect(viaEnv.projectDir).toBe("/w/r");
    expect(viaEnv.roots).toEqual(["/x", "/w/r/.claude/projects"]);
  });
});
