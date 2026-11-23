#!/usr/bin/env node
// Self-test for the tokenomics pipeline.
//
// Builds a synthetic project (board + transcripts) in a temp dir and runs the
// real collect -> rollup -> render scripts against it, asserting the parts that
// are easy to get silently wrong:
//   * requestId dedupe (without it, every token count roughly doubles)
//   * branch -> mission mapping, including the explicit `branches:` override
//   * authored sizing fields surviving into runs.json
//   * orchestrator vs subagent cost split
//   * unattributed work being reported, not dropped
//
// The whole suite runs TWICE — once against a `<kind>.yaml` board and once
// against a legacy `<kind>.md` one. That is not thoroughness for its own sake:
// this file used to build only a Markdown fixture, so it stayed green while the
// rollup read `mission.md` against a fully migrated YAML board, found zero
// missions, and reported the entire board's cost as unattributed. A board-format
// bug must fail here, not in a $1.6k report nobody re-reads.
//
// A reflog suite covers branch recovery when transcripts record `gitBranch: "HEAD"`,
// and that a re-keyed segment is not counted twice.
//
// A separate roots suite covers where transcripts are read from (slug filter, root
// precedence, dedupe) with HOME and CLAUDE_CONFIG_DIR isolated per child process.
//
// Usage: node .octobots/tokenomics/selftest.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import * as zlib from "node:zlib";
// A named import would fail to load on a Node without zstd (before 22.15); see the codex suite.
const zstdCompressSync = typeof zlib.zstdCompressSync === "function" ? zlib.zstdCompressSync : null;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
// Installed layout: <repo>/.octobots/tokenomics -> <repo>/.claude/skills/...
// Pack source layout: <pack>/tokenomics -> <pack>/skill/...
const VENDOR_YAML_CANDIDATES = [
  join(REPO, ".claude", "skills", "mission-planner", "scripts", "vendor", "js-yaml.mjs"),
  join(HERE, "..", "skill", "mission-planner", "scripts", "vendor", "js-yaml.mjs"),
];
const VENDOR_YAML = VENDOR_YAML_CANDIDATES.find((p) => existsSync(p)) ?? VENDOR_YAML_CANDIDATES[0];

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

// --- synthetic transcripts -------------------------------------------------
function turn({ branch, model = "claude-sonnet-5", requestId, out = 1000, cacheRead = 100000, ts = "2026-07-01T10:00:00.000Z", tool }) {
  return JSON.stringify({
    type: "assistant", gitBranch: branch, requestId, timestamp: ts,
    message: {
      model,
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 500 },
      content: tool ? [{ type: "tool_use", name: tool }] : [],
    },
  });
}

const SESSION = "s0000000-0000-0000-0000-000000000001";

// Claude Code's project slug: every non-alphanumeric char of the absolute path
// becomes "-" (so "/" and "_" and "." all collapse — `applied_ai` is stored as
// `applied-ai`). Deliberately re-stated here, not imported, so the test checks
// collect.mjs against the rule instead of against itself.
const slugOf = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

// Child-process env that can never see the developer's real transcripts: HOME is
// a temp dir and the transcript-root variables are dropped unless a case sets them.
function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const k of ["CLAUDE_CONFIG_DIR", "OCTOBOTS_TOKENOMICS_PROJECTS_DIR"]) if (!(k in extra)) delete env[k];
  return env;
}

function writeTranscripts(root) {
  // Legacy repo-local root, under the project's own slug.
  const projects = join(root, ".claude", "projects", slugOf(root));
  mkdirSync(projects, { recursive: true });

  writeFileSync(join(projects, `${SESSION}.jsonl`), [
    // Two records sharing one requestId — streaming duplicate. Must count ONCE.
    turn({ branch: "feat/demo-m1-t1", requestId: "req-1", tool: "Edit" }),
    turn({ branch: "feat/demo-m1-t1", requestId: "req-1", tool: "Edit" }),
    turn({ branch: "feat/demo-m1-t1", requestId: "req-2" }),
    // A branch only reachable via the mission's explicit `branches:` override.
    turn({ branch: "spike/unusual-name", requestId: "req-3" }),
    // Work with no mission — must land in the unattributed bucket.
    turn({ branch: "main", requestId: "req-4" }),
  ].join("\n") + "\n");

  // Two subagents, so the orchestrator/subagent split is exercised — one plain
  // Task subagent, and one Workflow-tool agent nested under `workflows/wf_*/`.
  // The nested case is the regression guard: a flat read of `subagents/` misses
  // every workflow agent, and since mission-execution leans heavily on workflows
  // that silently reports orchestrator_cost_pct as 100%.
  const subDir = join(projects, SESSION, "subagents");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, "agent-aaa.jsonl"), turn({ branch: "feat/demo-m1-t1", requestId: "req-s1", out: 500 }) + "\n");
  writeFileSync(join(subDir, "agent-aaa.meta.json"), JSON.stringify({ agentType: "python-dev", description: "sub work", spawnDepth: 1 }));

  const wfDir = join(subDir, "workflows", "wf_demo123");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "agent-bbb.jsonl"), turn({ branch: "feat/demo-m1-t1", requestId: "req-s2", out: 700 }) + "\n");
  writeFileSync(join(wfDir, "agent-bbb.meta.json"), JSON.stringify({ agentType: "js-dev", description: "workflow work", spawnDepth: 1 }));
}

// --- synthetic board -------------------------------------------------------
// One mission, same content in both formats, so every assertion below holds
// identically whichever the rollup had to read.
function writeBoard(root, format) {
  const campaignDir = join(root, ".octobots", "campaigns", "demo");
  const missionDir = join(campaignDir, "missions", "m1-demo-mission");
  const taskDir = join(missionDir, "tasks", "t1-1-demo-task");
  mkdirSync(taskDir, { recursive: true });
  // A directory is a campaign only with its own campaign file (BoardModel's rule, which rollup.mjs
  // follows); without one the mission below would belong to no campaign.
  if (format === "yaml") {
    writeFileSync(join(campaignDir, "campaign.yaml"), "name: Demo campaign\nstatus: active\ndescription: The self-test campaign.\nacceptance_criteria: []\n");
  } else {
    writeFileSync(join(campaignDir, "campaign.md"), "# Demo campaign\n\n## Description\n\nThe self-test campaign.\n");
  }

  if (format === "yaml") {
    writeFileSync(join(missionDir, "mission.yaml"), `name: M1 - Demo mission
status: active
description: |-
  A synthetic mission used by the tokenomics self-test.

  Tracker: aquanautica/vault#999
acceptance_criteria:
  - text: first criterion
    done: true
  - text: second criterion
    done: false
tokenomics:
  effort_days: 3
  size_tshirt: M
  complexity_score: 18
  maturity: pilot
  branches:
    - feat/demo-m1-t1
    - spike/unusual-name
`);
    // Children are folder-derived on a YAML board — the mission never lists them.
    writeFileSync(join(taskDir, "task.yaml"), `name: T1.1 - Demo task
status: done
role: python-dev
acceptance_criteria:
  - text: the task criterion
    done: true
tokenomics:
  effort_days: 1
  size_tshirt: S
`);
    return;
  }

  writeFileSync(join(missionDir, "mission.md"), `# M1 - Demo mission

## Description
A synthetic mission used by the tokenomics self-test.

Tracker: aquanautica/vault#999

## Acceptance Criteria
- [x] first criterion
- [ ] second criterion

## Tasks
- [role:python-dev] [status:done] T1.1 - Demo task

## Tokenomics
effort_days: 3
size_tshirt: M
complexity_score: 18
maturity: pilot
branches: feat/demo-m1-t1, spike/unusual-name
`);
  writeFileSync(join(taskDir, "task.md"), `# T1.1 - Demo task

## Tokenomics
effort_days: 1
size_tshirt: S
`);
}

function runSuite(format) {
  console.log(`\ntokenomics selftest — ${format} board:`);
  const root = mkdtempSync(join(tmpdir(), `tokenomics-selftest-${format}-`));
  const tag = (name) => `[${format}] ${name}`;

  writeTranscripts(root);
  writeBoard(root, format);

  // prices.json is read relative to the project dir, so copy the cached one.
  const tokDir = join(root, ".octobots", "tokenomics");
  mkdirSync(tokDir, { recursive: true });
  writeFileSync(join(tokDir, "prices.json"), readFileSync(join(HERE, "prices.json")));

  // The rollup resolves its YAML parser from the installed pack, so the fixture
  // needs one too — which also exercises that discovery path.
  if (format === "yaml" && existsSync(VENDOR_YAML)) {
    const vendorDir = join(root, ".claude", "skills", "mission-planner", "scripts", "vendor");
    mkdirSync(vendorDir, { recursive: true });
    copyFileSync(VENDOR_YAML, join(vendorDir, "js-yaml.mjs"));
  }

  // --- run the real pipeline -----------------------------------------------
  const emptyHome = mkdtempSync(join(tmpdir(), "tokenomics-selftest-home-"));
  for (const script of ["collect.mjs", "rollup.mjs", "render.mjs"]) {
    execFileSync(process.execPath, [join(HERE, script), "--project-dir", root, "--no-gh", "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env: isolatedEnv(emptyHome) });
  }

  const out = JSON.parse(readFileSync(join(tokDir, "runs.json"), "utf8"));
  const row = out.runs[0];

  check(tag("one mission row produced"), out.runs.length === 1, `got ${out.runs.length}`);
  check(tag("mission identified from the board"), row?._octobots.mission_id === "M1");
  check(tag("mission name read from the board"), row?._octobots.mission_name === "Demo mission", `got ${row?._octobots.mission_name}`);
  check(tag("tracker used as work_item_ref"), row?.work_item_ref === "aquanautica/vault#999");

  // 3 attributed orchestrator turns (req-1 counted once, req-2, req-3) + 2 subagents.
  check(tag("requestId dedupe applied"), row?.turns === 5, `turns=${row?.turns} (6 means the duplicate was double-counted)`);
  check(tag("explicit branches: override honoured"), row?._octobots.branches.includes("spike/unusual-name"));

  check(tag("authored effort_days parsed"), row?.effort_days === 3, `got ${row?.effort_days}`);
  check(tag("authored size_tshirt parsed"), row?.size_tshirt === "M");
  check(tag("authored complexity_score parsed"), row?.complexity_score === 18);
  check(tag("authored maturity parsed"), row?.maturity === "pilot");

  // The task must reach the report with its role, status and its OWN estimate —
  // on a YAML board all three come from task.yaml, not from a parent projection.
  const task = row?._octobots.tasks.find((t) => t.id === "T1.1");
  check(tag("declared task present in the breakdown"), Boolean(task), JSON.stringify(row?._octobots.tasks.map((t) => t.id)));
  check(tag("task name read from the board"), task?.name === "Demo task", `got ${task?.name}`);
  check(tag("task role read from the board"), task?.role === "python-dev", `got ${task?.role}`);
  check(tag("task status read from the board"), task?.status === "done", `got ${task?.status}`);
  check(tag("task effort_days parsed"), task?.effort_days === 1, `got ${task?.effort_days}`);
  check(tag("task size_tshirt parsed"), task?.size_tshirt === "S", `got ${task?.size_tshirt}`);

  check(tag("plain + workflow subagents both counted"), row?.subagent_dispatches === 2, `got ${row?.subagent_dispatches} (1 means workflows/ was not walked)`);
  check(tag("workflow agent type surfaced"), row?._octobots.agent_types.includes("js-dev"), JSON.stringify(row?._octobots.agent_types));
  check(tag("orchestrator split computed"), row?.orchestrator_cost_pct > 50 && row?.orchestrator_cost_pct < 100, `got ${row?.orchestrator_cost_pct}`);
  check(tag("cost is positive"), row?.cost_api_equivalent_usd > 0);
  // net_loc is a derived difference, never a stored one — added/removed must
  // reconcile to it, or the two halves came from different sources.
  check(tag("lines add/remove reconcile with net_loc"),
    row?.net_loc === null || row.net_loc === row.lines_added - row.lines_removed,
    `net=${row?.net_loc} added=${row?.lines_added} removed=${row?.lines_removed}`);
  check(tag("cache_read_share_pct in range"), row?.cache_read_share_pct >= 0 && row?.cache_read_share_pct <= 100);
  check(tag("criteria counted from the board"), row?._octobots.criteria === "1/2", `got ${row?._octobots.criteria}`);

  check(tag("unattributed work reported"), out.unattributed.branches.includes("main"), JSON.stringify(out.unattributed.branches));
  check(tag("unattributed cost is non-zero"), out.unattributed.cost_api_equivalent_usd > 0);
  // The failure this suite exists to catch: a board the rollup cannot read does
  // not error, it quietly reports every dollar as nobody's.
  check(tag("attributed cost is non-zero"), row?.cost_api_equivalent_usd > out.unattributed.cost_api_equivalent_usd * 0.1);

  const html = readFileSync(join(tokDir, "report.html"), "utf8");
  check(tag("report renders the mission"), html.includes("Demo mission"));
  check(tag("report is self-contained"), !/<script\s+src|https?:\/\/[^"']*\.(js|css|woff2?)/i.test(html));

  rmSync(root, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
}

// --- transcript root resolution ---------------------------------------------
function writeSession(projectsRoot, slug, sessionId, turns) {
  const dir = join(projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i++) lines.push(turn({ branch: "feat/roots-m1", requestId: `${sessionId}-r${i}` }));
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

// `projectDir` is what --project-dir receives (a worktree path in the worktree case); artifacts are
// written beneath it. Each call starts from an empty raw/ dir unless `keepRaw` (the rerun case).
function collectRaw(projectDir, env, extraArgs = [], keepRaw = false) {
  const rawDir = join(projectDir, ".octobots", "tokenomics", "raw");
  if (!keepRaw) rmSync(rawDir, { recursive: true, force: true });
  execFileSync(process.execPath, [join(HERE, "collect.mjs"), "--project-dir", projectDir, "--quiet", ...extraArgs], { stdio: ["ignore", "ignore", "inherit"], env });
  return readFileSync(join(rawDir, "segments.jsonl"), "utf8");
}
const parseSegments = (raw) => raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
function collectSegments(projectDir, env, extraArgs = []) {
  return parseSegments(collectRaw(projectDir, env, extraArgs));
}

function runRootsSuite() {
  console.log("\ntokenomics selftest — transcript roots:");
  const base = mkdtempSync(join(tmpdir(), "tokenomics-selftest-roots-"));
  const mk = (n) => { const d = join(base, n); mkdirSync(d, { recursive: true }); return d; };
  const ids = (segs) => segs.map((s) => s.session_id).sort();

  // Project path contains `_` and `.` on purpose: both must collapse to "-".
  const root = mk("my_proj.v2");
  const slug = slugOf(root);
  const home = mk("home");
  const cfg = mk("cfg");
  const explicit = mk("explicit");

  // AC1. Home default: ~/.claude/projects/<own slug>; other projects' slugs ignored.
  writeSession(join(home, ".claude", "projects"), slug, "home-session", 2);
  writeSession(join(home, ".claude", "projects"), slugOf(join(base, "other_project")), "other-session", 3);
  let segs = collectSegments(root, isolatedEnv(home));
  check("[roots][AC1] ~/.claude/projects is read by default", ids(segs).join() === "home-session", ids(segs).join());
  check("[roots][AC1] other projects' slugs are ignored", !ids(segs).includes("other-session"));
  check("[roots][AC1] slug rule: _ and . become -", segs[0]?.project_slug === slug && !/[._]/.test(slug), segs[0]?.project_slug);

  // AC2. CLAUDE_CONFIG_DIR replaces ~/.claude.
  writeSession(join(cfg, "projects"), slug, "cfg-session", 1);
  segs = collectSegments(root, isolatedEnv(home, { CLAUDE_CONFIG_DIR: cfg }));
  check("[roots][AC2] CLAUDE_CONFIG_DIR/projects wins over ~/.claude", ids(segs).join() === "cfg-session", ids(segs).join());

  // AC2. Explicit override: env var and --projects-dir both replace the config/home root.
  writeSession(explicit, slug, "explicit-session", 1);
  segs = collectSegments(root, isolatedEnv(home, { CLAUDE_CONFIG_DIR: cfg, OCTOBOTS_TOKENOMICS_PROJECTS_DIR: explicit }));
  check("[roots][AC2] env override replaces both", ids(segs).join() === "explicit-session", ids(segs).join());
  segs = collectSegments(root, isolatedEnv(home, { CLAUDE_CONFIG_DIR: cfg }), ["--projects-dir", explicit]);
  check("[roots][AC2] --projects-dir replaces both", ids(segs).join() === "explicit-session", ids(segs).join());

  // AC3. Legacy repo-local root merged IN ADDITION; same session in both roots counts once.
  const legacy = join(root, ".claude", "projects");
  writeSession(legacy, slug, "legacy-session", 4);
  writeSession(legacy, slug, "home-session", 5);   // also in the home root, with MORE turns
  writeSession(legacy, "-stale-other-project", "legacy-other", 1);
  const raw1 = collectRaw(root, isolatedEnv(home));
  segs = parseSegments(raw1);
  check("[roots][AC3] legacy root merged with home root", ids(segs).join() === "home-session,legacy-session", ids(segs).join());
  const dup = segs.filter((s) => s.session_id === "home-session");
  check("[roots][AC3] session in both roots is not double-counted, the copy with more turns wins",
    dup.length === 1 && dup[0].turns === 5, JSON.stringify(dup.map((s) => s.turns)));
  check("[roots][AC3] legacy: other slugs ignored too", !ids(segs).includes("legacy-other"));
  const raw2 = collectRaw(root, isolatedEnv(home), [], true);
  check("[roots][AC3] rerun is byte-identical", raw1 === raw2);

  // A worktree resolves to the main checkout's slug and legacy root, never its own.
  const wt = join(root, ".claude", "worktrees", "qa-wt");
  mkdirSync(wt, { recursive: true });
  segs = collectSegments(wt, isolatedEnv(home));
  check("[roots] worktree path resolves to the main checkout's slug", ids(segs).join() === "home-session,legacy-session", ids(segs).join());

  // The project path is resolved first: a trailing slash or a relative --project-dir must not change the slug.
  segs = collectSegments(`${root}/`, isolatedEnv(home));
  check("[roots] a trailing slash on --project-dir does not change the slug", ids(segs).join() === "home-session,legacy-session", ids(segs).join());
  // Relative case: the cwd is a realpath (macOS tmpdir is a symlink), so key the transcript by that.
  const relProj = mk("rel_proj");
  const relSlug = slugOf(realpathSync(relProj));
  writeSession(join(home, ".claude", "projects"), relSlug, "rel-session", 1);
  execFileSync(process.execPath, [join(HERE, "collect.mjs"), "--project-dir", basename(relProj), "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env: isolatedEnv(home), cwd: base });
  segs = parseSegments(readFileSync(join(relProj, ".octobots", "tokenomics", "raw", "segments.jsonl"), "utf8"));
  check("[roots] a relative --project-dir resolves against the cwd", ids(segs).join() === "rel-session", ids(segs).join());

  // AC3, the other direction: the EARLIER root (home) holds the richer copy. The case above has the
  // richer copy in the later (legacy) root, so "last root read wins" would pass it; this one would not.
  writeSession(join(home, ".claude", "projects"), slug, "rich-home-session", 6);
  writeSession(legacy, slug, "rich-home-session", 3);
  segs = collectSegments(root, isolatedEnv(home));
  const rich = segs.filter((s) => s.session_id === "rich-home-session");
  check("[roots][AC3] more turns wins even when the richer copy is in the earlier root, not just the last one read",
    rich.length === 1 && rich[0].turns === 6, JSON.stringify(rich.map((s) => s.turns)));

  // Isolation: the PARENT process env holds a decoy HOME and CLAUDE_CONFIG_DIR, each with a session
  // under this project's own slug. A child built with isolatedEnv must see neither. If it did, a
  // developer's real transcripts would leak into this selftest and make it machine-dependent.
  const decoyHome = mk("decoy-home");
  const decoyCfg = mk("decoy-cfg");
  writeSession(join(decoyHome, ".claude", "projects"), slug, "decoy-home-session", 1);
  writeSession(join(decoyCfg, "projects"), slug, "decoy-cfg-session", 1);
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = decoyHome;
  process.env.CLAUDE_CONFIG_DIR = decoyCfg;
  try {
    segs = collectSegments(root, isolatedEnv(home));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  check("[roots][isolation] the caller's CLAUDE_CONFIG_DIR does not leak in", !ids(segs).includes("decoy-cfg-session"), ids(segs).join());
  check("[roots][isolation] the caller's HOME does not leak in", !ids(segs).includes("decoy-home-session"), ids(segs).join());
  check("[roots][isolation] the isolated child still reads its own HOME", ids(segs).includes("home-session"), ids(segs).join());

  rmSync(base, { recursive: true, force: true });
}

// --- Codex source ----------------------------------------------------------
// Synthetic rollouts only: every id, path, count and string below is invented.
// SENTINEL is planted in every field the collector must NEVER read (prompts,
// instructions, replies), so a leak into raw/segments.jsonl is detectable.
const SENTINEL = "SENTINEL-PROMPT-TEXT-must-never-reach-the-repo";
const CODEX_REPO = "demo-owner/demo-repo";

function rolloutLine(timestamp, type, payload) { return JSON.stringify({ timestamp, type, payload }); }

function writeRollout(codexDir, { id, ts, cwd, branch, repoUrl, parent = null, agentPath = null, turns, zst = false }) {
  const day = ts.slice(0, 10).split("-");
  const dir = join(codexDir, ...day);
  mkdirSync(dir, { recursive: true });
  const git = { commit_hash: "0".repeat(40), repository_url: repoUrl };
  if (branch) git.branch = branch;
  const lines = [rolloutLine(ts, "session_meta", {
    id, session_id: id, timestamp: ts, cwd, originator: "codex-tui", cli_version: "0.0.0", git,
    base_instructions: SENTINEL, ...(parent ? { parent_thread_id: parent, agent_path: agentPath, agent_nickname: SENTINEL } : {}),
  })];
  for (const t of turns) {
    lines.push(rolloutLine(t.at, "turn_context", {
      turn_id: t.turn, cwd, model: t.model, effort: t.effort,
      collaboration_mode: { settings: { model: t.model, reasoning_effort: t.effort, developer_instructions: SENTINEL } },
    }));
    lines.push(rolloutLine(t.at, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: SENTINEL }] }));
    for (const r of t.responses) {
      const u = { input_tokens: r.in, cached_input_tokens: r.cached, cache_write_input_tokens: 0, output_tokens: r.out, reasoning_output_tokens: r.reason, total_tokens: r.in + r.out };
      lines.push(rolloutLine(r.at, "token_usage_record", { thread_id: id, turn_id: t.turn, session_id: id, response_id: r.id, usage: u, turn_token_usage: u, thread_token_usage: u }));
      // The same usage restated by the event stream: must not be added twice.
      lines.push(rolloutLine(r.at, "event_msg", { type: "token_count", info: { total_token_usage: u, last_token_usage: u }, rate_limits: { primary: { used_percent: 1 } } }));
    }
    lines.push(rolloutLine(t.at, "event_msg", { type: "task_complete", turn_id: t.turn, last_agent_message: SENTINEL }));
  }
  const body = lines.join("\n") + "\n";
  // Codex compresses older rollouts to .jsonl.zst; the collector must read both.
  if (zst && zstdCompressSync) writeFileSync(join(dir, `rollout-${ts.replace(/:/g, "-")}-${id}.jsonl.zst`), zstdCompressSync(Buffer.from(body)));
  else writeFileSync(join(dir, `rollout-${ts.replace(/:/g, "-")}-${id}.jsonl`), body);
}

// Counts are in thousands so costs are whole cents and a wrong rate cannot hide inside rounding.
const R = (id, at, i, c, o, r) => ({ id, at, in: i * 1000, cached: c * 1000, out: o * 1000, reason: r * 1000 });
const T = (turn, at, model, effort, responses) => ({ turn, at, model, effort, responses });

function writeCodexRollouts(root, codexDir) {
  const wt = join(root, ".worktrees", "builder");
  const url = `https://github.com/${CODEX_REPO}.git`;
  // A: a root builder session on a mission branch. Turn 1 repeats response r1
  // (dedupe on response_id), turn 2 switches model + effort mid-session.
  writeRollout(codexDir, { id: "a0000000-0000-0000-0000-00000000000a", ts: "2026-07-01T11:00:00.000Z", cwd: wt, branch: "feat/demo-m1-t1", repoUrl: url, turns: [
    T("ta1", "2026-07-01T11:00:01.000Z", "gpt-6.1-sol", "high", [R("r1", "2026-07-01T11:00:10.000Z", 1000, 800, 50, 20), R("r1", "2026-07-01T11:00:10.000Z", 1000, 800, 50, 20)]),
    T("ta2", "2026-07-01T11:05:00.000Z", "gpt-6-astra", "medium", [R("r2", "2026-07-01T11:05:10.000Z", 2000, 1500, 100, 40)]),
  ] });
  // B: a sub-agent forked by A.
  writeRollout(codexDir, { id: "b0000000-0000-0000-0000-00000000000b", ts: "2026-07-01T11:02:00.000Z", cwd: wt, branch: "feat/demo-m1-t1", repoUrl: url,
    parent: "a0000000-0000-0000-0000-00000000000a", agentPath: "/root/helper", zst: true, turns: [
      T("tb1", "2026-07-01T11:02:01.000Z", "gpt-6.1-sol", "high", [R("r3", "2026-07-01T11:02:10.000Z", 400, 0, 10, 0)]),
  ] });
  // C: another repository entirely.
  writeRollout(codexDir, { id: "c0000000-0000-0000-0000-00000000000c", ts: "2026-07-01T12:00:00.000Z", cwd: "/elsewhere/other-repo", branch: "feat/demo-m1-t1", repoUrl: "https://github.com/someone/other-repo.git", turns: [
    T("tc1", "2026-07-01T12:00:01.000Z", "gpt-6.1-sol", "high", [R("r4", "2026-07-01T12:00:10.000Z", 9999, 0, 9999, 0)]),
  ] });
  // D: this repo, no branch recorded, outside every ledger window.
  writeRollout(codexDir, { id: "d0000000-0000-0000-0000-00000000000d", ts: "2026-07-05T10:00:00.000Z", cwd: wt, branch: null, repoUrl: url, turns: [
    T("td1", "2026-07-05T10:00:01.000Z", "gpt-6.1-sol", "high", [R("r5", "2026-07-05T10:00:10.000Z", 100, 0, 5, 0)]),
  ] });
  // E: started on main (orchestrator cuts the branch later) inside M1's dispatch window.
  writeRollout(codexDir, { id: "e0000000-0000-0000-0000-00000000000e", ts: "2026-07-02T12:00:00.000Z", cwd: root, branch: "main", repoUrl: url, turns: [
    T("te1", "2026-07-02T12:00:01.000Z", "gpt-6.1-terra", "xhigh", [R("r6", "2026-07-02T12:00:10.000Z", 3000, 1000, 200, 50)]),
  ] });
  // F: a model prices.json does not know.
  writeRollout(codexDir, { id: "f0000000-0000-0000-0000-00000000000f", ts: "2026-07-01T13:00:00.000Z", cwd: wt, branch: "feat/demo-m1-t1", repoUrl: url, turns: [
    T("tf1", "2026-07-01T13:00:01.000Z", "gpt-9-unknown", "high", [R("r7", "2026-07-01T13:00:10.000Z", 10, 0, 1, 0)]),
  ] });
}

// Delivery ledger fixture: M1 was dispatched 07-02 09:00 and done 07-02 18:00.
function writeLedger(root) {
  const dir = join(root, ".agents", "telemetry", "delivery");
  mkdirSync(dir, { recursive: true });
  const ev = (at, level, ref, event, item) => JSON.stringify({ v: 2, at, plan: "demo/run-1", item_id: `demo/run-1/${item}`, ref, level, event });
  writeFileSync(join(dir, "events-test.jsonl"), [
    ev("2026-06-30T00:00:00.000Z", "mission", "M1", "created", "mission-m1"),
    ev("2026-07-02T09:00:00.000Z", "mission", "M1", "dispatched", "mission-m1"),
    ev("2026-07-02T18:00:00.000Z", "mission", "M1", "done", "mission-m1"),
  ].join("\n") + "\n");
}

function runCodexSuite() {
  console.log("\ntokenomics selftest — codex source:");
  const root = mkdtempSync(join(tmpdir(), "tokenomics-selftest-codex-"));
  const codexDir = join(root, "codex-sessions");
  writeTranscripts(root);
  writeBoard(root, "yaml");
  writeLedger(root);
  const tokDir = join(root, ".octobots", "tokenomics");
  mkdirSync(tokDir, { recursive: true });
  const pricesText = readFileSync(join(HERE, "prices.json"), "utf8");
  writeFileSync(join(tokDir, "prices.json"), pricesText);
  const prices = JSON.parse(pricesText).models;
  const vendorDir = join(root, ".claude", "skills", "mission-planner", "scripts", "vendor");
  mkdirSync(vendorDir, { recursive: true });
  copyFileSync(VENDOR_YAML, join(vendorDir, "js-yaml.mjs"));
  const home = mkdtempSync(join(tmpdir(), "tokenomics-selftest-home-"));
  const env = isolatedEnv(home);
  const sh = (script, extra = []) => execFileSync(process.execPath, [join(HERE, script), "--project-dir", root, "--no-gh", ...extra], { stdio: ["ignore", "ignore", "pipe"], env, encoding: "utf8" });
  const rawFile = join(tokDir, "raw", "segments.jsonl");
  // rollup's WARNINGs go to stderr; capture them (execFileSync only returns stdout).
  const rollup = () => {
    const r = spawnSync(process.execPath, [join(HERE, "rollup.mjs"), "--project-dir", root, "--no-gh"], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`rollup failed: ${r.stderr}`);
    return r.stderr;
  };
  const loadRuns = () => JSON.parse(readFileSync(join(tokDir, "runs.json"), "utf8"));
  const collectCodex = (extra = []) => execFileSync(process.execPath, [join(HERE, "collect-codex.mjs"), "--project-dir", root, "--codex-dir", codexDir, "--repo", CODEX_REPO, "--quiet", ...extra], { stdio: ["ignore", "ignore", "inherit"], env });

  // Baseline: Claude only.
  sh("collect.mjs", ["--quiet"]);
  rollup();
  const base = loadRuns();
  const baseRow = base.runs[0];

  writeCodexRollouts(root, codexDir);
  collectCodex();
  const raw1 = readFileSync(rawFile, "utf8");
  const segs = raw1.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const codex = segs.filter((s) => s.source === "codex");
  const byThread = (c) => codex.find((s) => s.thread_id?.startsWith(c));

  check("[codex] one segment per session x branch (A,B,D,E,F; C is another repo)", codex.length === 5, `got ${codex.length}: ${codex.map((s) => s.thread_id.slice(0, 1)).join()}`);
  check("[codex] zstd-compressed rollout (.jsonl.zst) is read", Boolean(byThread("b")) && byThread("b")?.tokens_by_model["gpt-6.1-sol"]?.input_tokens === 400000);
  check("[codex] other repo's session excluded", !byThread("c"));
  check("[codex] claude segments keep no source tag (byte-identical rows)", segs.filter((s) => s.source !== "codex").every((s) => !("source" in s)));
  check("[codex] segment ids are unique and carry the agent key", new Set(segs.map((s) => s.segment_id)).size === segs.length && byThread("b")?.segment_id.includes("/root/helper"), byThread("b")?.segment_id);

  const a = byThread("a");
  check("[codex] A: turns count unique responses (dup response_id once)", a?.turns === 2, `turns=${a?.turns}`);
  check("[codex] A: non-cached input = input - cached", a?.tokens_by_model["gpt-6.1-sol"]?.input_tokens === 200000, JSON.stringify(a?.tokens_by_model));
  check("[codex] A: cached input lands in cache_read", a?.tokens_by_model["gpt-6.1-sol"]?.cache_read_input_tokens === 800000);
  check("[codex] A: output tokens (reasoning is a subset, not added)", a?.tokens_by_model["gpt-6.1-sol"]?.output_tokens === 50000 && a?.tokens_by_model["gpt-6.1-sol"]?.reasoning_output_tokens === 20000);
  check("[codex] A: model switch mid-session split per model", a?.tokens_by_model["gpt-6-astra"]?.input_tokens === 500000 && a?.tokens_by_model["gpt-6-astra"]?.cache_read_input_tokens === 1500000, JSON.stringify(a?.tokens_by_model["gpt-6-astra"]));
  check("[codex] A: models and efforts recorded", a?.models_used.join() === "gpt-6-astra,gpt-6.1-sol" && a?.efforts_used.join() === "high,medium", `${a?.models_used} ${a?.efforts_used}`);
  check("[codex] A: timestamps from the usage records", a?.started_at === "2026-07-01T11:00:10.000Z" && a?.ended_at === "2026-07-01T11:05:10.000Z", `${a?.started_at} ${a?.ended_at}`);
  check("[codex] A: root session is an orchestrator-less 'codex' kind", a?.kind === "codex" && a?.session_id === a?.thread_id);
  const b = byThread("b");
  check("[codex] B: sub-agent rolls up under its parent session", b?.kind === "codex-subagent" && b?.session_id === a?.thread_id && b?.agent_path === "/root/helper", JSON.stringify([b?.kind, b?.session_id, b?.agent_path]));
  check("[codex] D: no recorded branch -> (none), not dropped", byThread("d")?.branch === "(none)");

  // AC3: nothing from prompts / instructions / replies reaches the repo.
  check("[codex] no prompt/instruction/reply text reaches segments.jsonl", !raw1.includes("SENTINEL"));
  const allowed = new Set(["segment_id", "session_id", "thread_id", "parent_thread_id", "project_slug", "source", "kind", "agent_type", "agent_path", "branch", "cwd", "started_at", "ended_at", "turns", "models_used", "efforts_used", "tokens_by_model", "tools"]);
  check("[codex] segment carries whitelisted keys only", codex.every((s) => Object.keys(s).every((k) => allowed.has(k))), codex.flatMap((s) => Object.keys(s)).filter((k) => !allowed.has(k)).join());

  // AC1: idempotent, and re-collecting never disturbs Claude rows.
  collectCodex();
  check("[codex] collect-codex is idempotent", readFileSync(rawFile, "utf8") === raw1);
  sh("collect.mjs", ["--quiet"]);
  check("[codex] collect.mjs re-run keeps codex rows byte-identical", readFileSync(rawFile, "utf8") === raw1);

  // --- rollup ---------------------------------------------------------------
  const warn = rollup();
  const out = loadRuns();
  const row = out.runs[0];
  const cost = (model, { input_tokens: i = 0, cache_read_input_tokens: c = 0, output_tokens: o = 0 }) =>
    i * prices[model].input_cost_per_token + c * prices[model].cache_read_input_token_cost + o * prices[model].output_cost_per_token;
  check("[codex] prices.json carries the Codex models in use", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra"].every((m) => prices[m]?.input_cost_per_token > 0 && prices[m]?.output_cost_per_token > 0));

  const expA = cost("gpt-6.1-sol", { input_tokens: 200000, cache_read_input_tokens: 800000, output_tokens: 50000 }) + cost("gpt-6-astra", { input_tokens: 500000, cache_read_input_tokens: 1500000, output_tokens: 100000 });
  const expB = cost("gpt-6.1-sol", { input_tokens: 400000, output_tokens: 10000 });
  const expE = cost("gpt-6.1-terra", { input_tokens: 2000000, cache_read_input_tokens: 1000000, output_tokens: 200000 });
  const expRow = expA + expB + expE; // F is unpriced: contributes 0 and is reported
  check("[codex] mission row carries Codex cost (A+B by branch, E by ledger window)", Math.abs((row?.codex?.cost_api_equivalent_usd ?? -1) - expRow) < 0.01 && expRow > 0, `got ${row?.codex?.cost_api_equivalent_usd} want ${expRow}`);
  check("[codex] cost_by_model shows gpt models next to claude", row?.cost_by_model["gpt-6.1-sol"] > 0 && row?.cost_by_model["gpt-6-astra"] > 0 && "claude-sonnet-5" in row.cost_by_model);
  check("[codex] total = claude cost + codex cost", Math.abs(row?.cost_api_equivalent_usd - (baseRow.cost_api_equivalent_usd + row?.codex?.cost_api_equivalent_usd)) < 0.011, `${row?.cost_api_equivalent_usd} vs ${baseRow.cost_api_equivalent_usd}+${row?.codex?.cost_api_equivalent_usd}`);
  check("[codex] cost_by_source splits Claude from Codex", row?.cost_by_source?.claude === baseRow.cost_api_equivalent_usd && row?.cost_by_source?.codex === row?.codex?.cost_api_equivalent_usd, JSON.stringify(row?.cost_by_source));
  for (const k of ["turns", "sessions", "subagent_dispatches", "orchestrator_cost_pct", "cache_read_share_pct", "primary_model"]) {
    check(`[codex] claude figure unchanged: ${k}`, row?.[k] === baseRow[k], `${row?.[k]} vs ${baseRow[k]}`);
  }
  check("[codex] attribution split recorded (branch vs ledger window)", row?.codex?.attribution?.branch === 3 && row?.codex?.attribution?.ledger_window === 1, JSON.stringify(row?.codex?.attribution));
  check("[codex] codex counters live under codex", row?.codex?.sessions === 3 && row?.codex?.subagent_dispatches === 1 && row?.codex?.turns === 5, JSON.stringify([row?.codex?.sessions, row?.codex?.subagent_dispatches, row?.codex?.turns]));
  const t1 = row?._octobots.tasks.find((t) => t.id === "T1.1");
  check("[codex] task row picks up Codex cost by branch", t1?.cost_by_source?.codex > 0 && Math.abs(t1.cost_by_source.codex - (expA + expB)) < 0.01, JSON.stringify(t1?.cost_by_source));
  check("[codex] no-branch codex work is unattributed, not dropped", out.unattributed.by_source?.codex > 0 && out.unattributed.branches.includes("(none)"), JSON.stringify(out.unattributed));
  check("[codex] unattributed bucket carries its Codex token share (verify.mjs input)", out.unattributed.codex_tokens?.input > 0 && out.unattributed.codex_tokens.input < out.unattributed.tokens.input + 1, JSON.stringify(out.unattributed.codex_tokens));
  check("[codex] unpriced Codex model is reported like an unpriced Claude model", /unpriced models.*gpt-9-unknown/.test(warn), warn);
  check("[codex] top-level source summary", out.by_source?.codex?.segments === 5 && out.by_source?.claude?.cost_api_equivalent_usd >= 0, JSON.stringify(out.by_source));

  const ccA = JSON.stringify(Object.entries(baseRow).filter(([k]) => ["work_item_ref", "effort_days", "size_tshirt"].includes(k)));
  check("[codex] authored fields untouched", ccA === JSON.stringify(Object.entries(row).filter(([k]) => ["work_item_ref", "effort_days", "size_tshirt"].includes(k))));

  // --- report ---------------------------------------------------------------
  sh("render.mjs", ["--quiet"]);
  const html = readFileSync(join(tokDir, "report.html"), "utf8");
  check("[codex] report shows the Claude/Codex split", /Claude \/ Codex/.test(html) && html.includes("gpt-6.1-sol"));
  check("[codex] report labels Codex cost API-equivalent", /Codex[^<]*API-equivalent|API-equivalent[^<]*Codex/.test(html));

  // --- Claude-only project: no Codex keys at all ------------------------------
  const clean = mkdtempSync(join(tmpdir(), "tokenomics-selftest-nocodex-"));
  writeTranscripts(clean); writeBoard(clean, "yaml"); writeLedger(clean);
  mkdirSync(join(clean, ".octobots", "tokenomics"), { recursive: true });
  writeFileSync(join(clean, ".octobots", "tokenomics", "prices.json"), pricesText);
  mkdirSync(join(clean, ".claude", "skills", "mission-planner", "scripts", "vendor"), { recursive: true });
  copyFileSync(VENDOR_YAML, join(clean, ".claude", "skills", "mission-planner", "scripts", "vendor", "js-yaml.mjs"));
  for (const script of ["collect.mjs", "rollup.mjs", "render.mjs"]) execFileSync(process.execPath, [join(HERE, script), "--project-dir", clean, "--no-gh", "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env });
  const cleanOut = JSON.parse(readFileSync(join(clean, ".octobots", "tokenomics", "runs.json"), "utf8"));
  const text = JSON.stringify(cleanOut);
  check("[codex] no Codex segments -> no codex/by_source keys anywhere", !/"codex"|by_source|cost_by_source/.test(text));
  check("[codex] no Codex segments -> report has no split section", !/Claude \/ Codex/.test(readFileSync(join(clean, ".octobots", "tokenomics", "report.html"), "utf8")));
  check("[codex] collect-codex on an empty Codex dir changes nothing", (() => {
    const before = readFileSync(join(clean, ".octobots", "tokenomics", "raw", "segments.jsonl"), "utf8");
    execFileSync(process.execPath, [join(HERE, "collect-codex.mjs"), "--project-dir", clean, "--codex-dir", join(clean, "nope"), "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env });
    return readFileSync(join(clean, ".octobots", "tokenomics", "raw", "segments.jsonl"), "utf8") === before;
  })());

  for (const d of [root, clean, home]) rmSync(d, { recursive: true, force: true });
}

// --- mission ids with a letter suffix (M6 vs M6b) ---------------------------
// A letter-suffixed mission is its own mission, never folded into the bare number.
function runSuffixSuite() {
  console.log("\ntokenomics selftest — letter-suffixed mission ids:");
  const root = mkdtempSync(join(tmpdir(), "tokenomics-selftest-sfx-"));
  const emptyHome = mkdtempSync(join(tmpdir(), "tokenomics-selftest-home-"));
  const camp = join(root, ".octobots", "campaigns", "sfx");
  const mk = (rel, body) => { const f = join(camp, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); };
  mk("campaign.yaml", "name: Sfx campaign\nstatus: active\ndescription: x\nacceptance_criteria: []\n");
  mk("missions/m6b-overlap/mission.yaml", "name: M6b - Overlap\nstatus: done\ndescription: x\nacceptance_criteria:\n  - text: a\n    done: true\ntokenomics:\n  branches: feat/sfx-m6b, feat/sfx-m6b-t1\n");
  mk("missions/m6-heavy/mission.yaml", "name: M6 - Heavy\nstatus: cancelled\ndescription: x\nacceptance_criteria: []\ntokenomics:\n  branches: spike/m6-odd\n");
  mk("missions/m6b-overlap/tasks/t6b-1-one/task.yaml", "name: T6b.1 - One\nstatus: done\n");
  mk("missions/m6b-overlap/tasks/t6b-2-two/task.yaml", "name: T6b.2 - Two\nstatus: done\n");

  const projects = join(root, ".claude", "projects", slugOf(root));
  mkdirSync(projects, { recursive: true });
  const turns = [];
  const add = (branch, n) => { for (let i = 0; i < n; i++) turns.push(turn({ branch, requestId: `${branch}-${i}` })); };
  add("spike/m6-odd", 1);       // M6 declared
  add("feat/sfx-m6", 2);        // M6 by convention
  add("feat/sfx-m6b", 1);       // M6b declared
  add("feat/sfx-m6b-t1", 1);    // M6b declared task branch
  add("feat/sfx-m6b-t2", 3);    // M6b by convention, task T6b.2
  writeFileSync(join(projects, `${SESSION}.jsonl`), turns.join("\n") + "\n");

  const tokDir = join(root, ".octobots", "tokenomics");
  mkdirSync(tokDir, { recursive: true });
  writeFileSync(join(tokDir, "prices.json"), readFileSync(join(HERE, "prices.json")));
  const vendorDir = join(root, ".claude", "skills", "mission-planner", "scripts", "vendor");
  mkdirSync(vendorDir, { recursive: true });
  if (existsSync(VENDOR_YAML)) copyFileSync(VENDOR_YAML, join(vendorDir, "js-yaml.mjs"));
  for (const script of ["collect.mjs", "rollup.mjs"]) {
    execFileSync(process.execPath, [join(HERE, script), "--project-dir", root, "--no-gh", "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env: isolatedEnv(emptyHome) });
  }
  const out = JSON.parse(readFileSync(join(tokDir, "runs.json"), "utf8"));
  const byId = (id) => out.runs.find((r) => r._octobots.mission_id === id);
  const m6 = byId("M6"), m6b = byId("M6b");
  check("[sfx] two separate rows, M6 and M6b", out.runs.length === 2 && Boolean(m6) && Boolean(m6b), JSON.stringify(out.runs.map((r) => r._octobots.mission_id)));
  check("[sfx] M6 holds only its own turns", m6?.turns === 3, `turns=${m6?.turns}`);
  check("[sfx] M6b holds only its own turns", m6b?.turns === 5, `turns=${m6b?.turns}`);
  check("[sfx] M6b convention branch attributed", m6b?._octobots.branches.includes("feat/sfx-m6b-t2"), JSON.stringify(m6b?._octobots.branches));
  check("[sfx] M6 convention branch not stolen by M6b", m6?._octobots.branches.includes("feat/sfx-m6") && !m6._octobots.branches.some((b) => b.includes("m6b")), JSON.stringify(m6?._octobots.branches));
  check("[sfx] M6b declared task branch stays with M6b", m6b?._octobots.branches.includes("feat/sfx-m6b-t1"));
  check("[sfx] M6b name from title", m6b?._octobots.mission_name === "Overlap", `got ${m6b?._octobots.mission_name}`);
  check("[sfx] M6b criteria", m6b?._octobots.criteria === "1/1", `got ${m6b?._octobots.criteria}`);
  const ids = m6b?._octobots.tasks.map((t) => t.id) ?? [];
  check("[sfx] M6b tasks are T6b.k", ids.includes("T6b.1") && ids.includes("T6b.2"), JSON.stringify(ids));
  const t2 = m6b?._octobots.tasks.find((t) => t.id === "T6b.2");
  check("[sfx] task branch -t2 costs T6b.2", t2?.turns === 3, JSON.stringify(t2));

  for (const d of [root, emptyHome]) rmSync(d, { recursive: true, force: true });
}

// --- reflog branch recovery (from coach-android's fork, 2026-08-07) ----------
// Claude Code builds from mid-2026 stamped `gitBranch: "HEAD"` on EVERY record,
// even on a named branch (2400 of 2400 records in one project). Every segment
// then buckets under one meaningless branch, maps to no mission, and the whole
// campaign reports as unattributed while the collector exits 0. The collector
// falls back to the reflog, which records which branch HEAD pointed at over
// time. Current builds record the real branch; the fallback still matters when
// old transcripts are collected again.
function runReflogSuite() {
  console.log(`\ntokenomics selftest — reflog branch recovery:`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tokenomics-selftest-reflog-")));
  const emptyHome = mkdtempSync(join(tmpdir(), "tokenomics-selftest-home-"));
  const tag = (name) => `[reflog] ${name}`;
  const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (env, ...a) =>
    execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, ...gitEnv, ...env } });

  // A repo whose reflog says: main until Jan 2, feat/demo-m1-t1 until Jan 3,
  // main after. Reflog entry times honour GIT_COMMITTER_DATE, so this is exact
  // rather than wall-clock dependent.
  git({}, "init", "-q", "-b", "main");
  git({}, "config", "user.email", "selftest@example.com");
  git({}, "config", "user.name", "selftest");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git({}, "add", "seed.txt");
  git({ GIT_COMMITTER_DATE: "2026-01-01T10:00:00+0000", GIT_AUTHOR_DATE: "2026-01-01T10:00:00+0000" }, "commit", "-qm", "seed");
  git({ GIT_COMMITTER_DATE: "2026-01-02T10:00:00+0000" }, "checkout", "-q", "-b", "feat/demo-m1-t1");
  git({ GIT_COMMITTER_DATE: "2026-01-03T10:00:00+0000" }, "checkout", "-q", "main");

  // Every record claims "HEAD", as those transcripts did; only the timestamps differ.
  // One record names its branch: a real name always wins over the reflog.
  const projects = join(root, ".claude", "projects", slugOf(root));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${SESSION}.jsonl`), [
    turn({ branch: "HEAD", requestId: "rf-0", ts: "2025-12-31T12:00:00.000Z" }), // before the reflog begins
    turn({ branch: "HEAD", requestId: "rf-1", ts: "2026-01-01T12:00:00.000Z" }), // before any checkout
    turn({ branch: "HEAD", requestId: "rf-2", ts: "2026-01-02T12:00:00.000Z" }), // feature window
    turn({ branch: "HEAD", requestId: "rf-3", ts: "2026-01-03T12:00:00.000Z" }), // back on main
    turn({ branch: "fix/named", requestId: "rf-4", ts: "2026-01-02T13:00:00.000Z" }),
  ].join("\n") + "\n");

  const tokDir = join(root, ".octobots", "tokenomics");
  const rawFile = join(tokDir, "raw", "segments.jsonl");
  const collect = () => execFileSync(process.execPath, [join(HERE, "collect.mjs"), "--project-dir", root, "--quiet"],
    { stdio: ["ignore", "ignore", "inherit"], env: isolatedEnv(emptyHome) });
  const read = () => readFileSync(rawFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  collect();
  const segs = read();
  const branches = new Set(segs.map((s) => s.branch));
  const got = `got ${JSON.stringify([...branches])}`;
  const headTurns = segs.filter((s) => s.branch === "HEAD").reduce((n, s) => n + s.turns, 0);
  check(tag("only the record older than the reflog stays on HEAD (nothing is guessed)"), headTurns === 1, `${got}, HEAD turns ${headTurns}`);
  check(tag("feature-branch work recovered from the reflog"), branches.has("feat/demo-m1-t1"), got);
  check(tag("main work recovered from the reflog"), branches.has("main"), got);
  check(tag("a real gitBranch wins over the reflog"), branches.has("fix/named"), got);
  // A record predating every checkout belongs to the branch the repo started on.
  check(tag("pre-first-checkout work resolves, not dropped"),
    segs.reduce((n, s) => n + (s.turns ?? 0), 0) === 5,
    `turns=${segs.map((s) => `${s.branch}:${s.turns}`).join(" ")}`);

  // --- re-keying must not double count ---------------------------------------
  // `segment_id` embeds the branch, so a change in how a branch is resolved
  // re-keys a segment, and a merge purely on id keeps the old key AND the new
  // one: coach-android's total doubled from $223 to $449 this way, with the
  // collector exiting 0. A re-scanned session is authoritative for itself; a
  // session whose transcript is gone must survive untouched.
  const stale = { ...segs[0], segment_id: `${SESSION}:main:HEAD`, branch: "HEAD", turns: 1 };
  const staleOther = { ...segs[0], segment_id: `${SESSION}:main:HEAD-stale`, branch: "HEAD", turns: 999 };
  const foreign = { ...segs[0], segment_id: "s0000000-dead-dead-dead-000000000002:main:main", session_id: "s0000000-dead-dead-dead-000000000002", turns: 7 };
  writeFileSync(rawFile, [...segs.filter((s) => s.branch !== "HEAD"), stale, foreign, { ...staleOther, branch: "HEAD" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  collect();
  const after = read();
  const ids = `ids=${after.map((s) => s.segment_id).join(" ")}`;
  check(tag("a stale HEAD segment of a re-scanned session is dropped, not double counted"), !after.some((s) => s.segment_id === `${SESSION}:main:HEAD-stale`), ids);
  check(tag("a session that was NOT re-scanned survives the merge"), after.some((s) => s.segment_id.startsWith("s0000000-dead")), ids);
  check(tag("turns stay stable across a re-run"),
    after.filter((s) => s.segment_id.startsWith(SESSION)).reduce((n, s) => n + (s.turns ?? 0), 0) === 5,
    `turns=${after.map((s) => `${s.branch}:${s.turns}`).join(" ")}`);

  // --- the reflog is gone (expired, or the repo re-cloned at the same path) --
  // A re-run must keep the branches resolved earlier: not pin the records to the
  // branch checked out now, not swap them for HEAD, and not count them twice.
  rmSync(join(root, ".git", "logs"), { recursive: true, force: true });
  git({}, "checkout", "-q", "-b", "unrelated-now");
  const resolvedBefore = after.filter((s) => s.segment_id.startsWith(SESSION) && s.branch !== "HEAD").map((s) => s.segment_id).sort();
  collect();
  const gone = read();
  const mine = gone.filter((s) => s.segment_id.startsWith(SESSION));
  check(tag("reflog gone: no record is pinned to the branch checked out now"), !mine.some((s) => s.branch === "unrelated-now"), JSON.stringify(mine.map((s) => s.branch)));
  check(tag("reflog gone: the branches resolved earlier are kept"),
    JSON.stringify(mine.filter((s) => s.branch !== "HEAD").map((s) => s.segment_id).sort()) === JSON.stringify(resolvedBefore), JSON.stringify(mine.map((s) => s.segment_id)));
  check(tag("reflog gone: turns are not counted twice"), mine.reduce((n, s) => n + s.turns, 0) === 5, `turns=${mine.map((s) => `${s.branch}:${s.turns}`).join(" ")}`);

  for (const d of [root, emptyHome]) rmSync(d, { recursive: true, force: true });
}

if (!existsSync(VENDOR_YAML)) {
  console.log(`  WARN vendored js-yaml not found at ${VENDOR_YAML} — the yaml suite cannot run`);
  failures++;
}

for (const format of ["yaml", "md"]) runSuite(format);
runRootsSuite();
runCodexSuite();
runSuffixSuite();
runReflogSuite();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
